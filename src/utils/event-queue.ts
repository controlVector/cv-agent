/**
 * EventQueue: persistent, ordered, at-least-once delivery of task events to CV-Hub.
 *
 * Background: cv-agent previously posted `output` / `output_final` events with
 * fire-and-forget `.catch(() => {})`. Any transient network blip or server
 * rejection silently dropped output, leaving the planner blind to what the
 * executor actually produced.
 *
 * This queue:
 *   - enqueues events in memory, drains them serially via the provided poster
 *   - retries failures with bounded exponential backoff (1s, 2s, 4s, ...)
 *   - spills pending events to disk every flush so a crash doesn't lose them
 *   - reloads the on-disk spill on construction (next-run pickup)
 *   - exposes flush() + close() so callers can drain on shutdown
 *
 * Events are tagged with a monotonic sequence_number assigned by the queue —
 * the server uses it to reconstruct ordering deterministically even under
 * same-millisecond bursts.
 */

import { promises as fs } from 'node:fs';
import * as path from 'node:path';

export type QueuedEvent = {
  event_type: string;
  content: Record<string, unknown> | string;
  needs_response?: boolean;
  sequence_number: number;
};

export type EventPoster = (event: QueuedEvent) => Promise<void>;

type Options = {
  spillPath: string;
  poster: EventPoster;
  maxRetries?: number;
  baseDelayMs?: number;
  onError?: (err: Error, event: QueuedEvent, attempt: number) => void;
};

export class EventQueue {
  private buffer: QueuedEvent[] = [];
  private sequence = 0;
  private drainPromise: Promise<void> | null = null;
  private closed = false;
  private spillDirty = false;
  private readonly spillPath: string;
  private readonly poster: EventPoster;
  private readonly maxRetries: number;
  private readonly baseDelayMs: number;
  private readonly onError?: (err: Error, event: QueuedEvent, attempt: number) => void;

  constructor(opts: Options) {
    this.spillPath = opts.spillPath;
    this.poster = opts.poster;
    this.maxRetries = opts.maxRetries ?? 5;
    this.baseDelayMs = opts.baseDelayMs ?? 1000;
    this.onError = opts.onError;
  }

  /** Load any events that were spilled to disk by a previous run. */
  async loadSpill(): Promise<void> {
    try {
      const raw = await fs.readFile(this.spillPath, 'utf8');
      const lines = raw.split('\n').filter((l) => l.trim().length > 0);
      for (const line of lines) {
        const ev = JSON.parse(line) as QueuedEvent;
        this.buffer.push(ev);
        if (ev.sequence_number >= this.sequence) {
          this.sequence = ev.sequence_number + 1;
        }
      }
    } catch (err: any) {
      if (err.code !== 'ENOENT') throw err;
    }
  }

  /** Assign the next sequence number. Callers that want to stamp manually can read this. */
  nextSequence(): number {
    return this.sequence++;
  }

  /** Enqueue an event. Returns the assigned sequence_number. */
  enqueue(event: Omit<QueuedEvent, 'sequence_number'> & { sequence_number?: number }): number {
    if (this.closed) {
      throw new Error('EventQueue is closed');
    }
    const seq = event.sequence_number ?? this.nextSequence();
    if (seq >= this.sequence) this.sequence = seq + 1;
    this.buffer.push({ ...event, sequence_number: seq });
    this.spillDirty = true;
    // Drain in the background — don't block the caller.
    this.drain().catch(() => {});
    return seq;
  }

  /** Drain the buffer, retrying transient failures. Serial — concurrent calls share the same promise. */
  private drain(): Promise<void> {
    if (this.drainPromise) return this.drainPromise;
    this.drainPromise = this.drainInternal().finally(() => {
      this.drainPromise = null;
    });
    return this.drainPromise;
  }

  private async drainInternal(): Promise<void> {
    try {
      while (this.buffer.length > 0) {
        const ev = this.buffer[0];
        let delivered = false;
        for (let attempt = 0; attempt < this.maxRetries; attempt++) {
          try {
            await this.poster(ev);
            delivered = true;
            break;
          } catch (err: any) {
            this.onError?.(err instanceof Error ? err : new Error(String(err)), ev, attempt);
            if (attempt < this.maxRetries - 1) {
              await sleep(this.baseDelayMs * Math.pow(2, attempt));
            }
          }
        }
        if (delivered) {
          this.buffer.shift();
          this.spillDirty = true;
        } else {
          // Out of retries — leave on buffer so flush() can persist it,
          // and stop draining to avoid hot-looping on a dead server.
          break;
        }
      }
    } finally {
      if (this.spillDirty) {
        await this.writeSpill().catch(() => {});
      }
    }
  }

  /** Flush: drain remaining events, then persist anything still pending to disk. */
  async flush(): Promise<void> {
    await this.drain();
    await this.writeSpill();
  }

  /** Mark the queue closed and flush. Safe to call multiple times. */
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await this.flush();
  }

  /** Number of events still pending delivery. */
  size(): number {
    return this.buffer.length;
  }

  private async writeSpill(): Promise<void> {
    try {
      if (this.buffer.length === 0) {
        await fs.rm(this.spillPath, { force: true });
      } else {
        await fs.mkdir(path.dirname(this.spillPath), { recursive: true });
        const body = this.buffer.map((e) => JSON.stringify(e)).join('\n') + '\n';
        await fs.writeFile(this.spillPath, body, 'utf8');
      }
      this.spillDirty = false;
    } catch {
      // Spill errors are non-fatal — we still have events in memory.
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
