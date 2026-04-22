/**
 * Tests for event-queue.ts — retry, disk spill, flush-on-exit, ordering.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { EventQueue, type QueuedEvent } from './event-queue';

function tmpSpill(name: string): string {
  return path.join(os.tmpdir(), 'cva-event-queue-test', `${name}-${Date.now()}-${Math.random()}.ndjson`);
}

async function rmf(p: string) {
  await fs.rm(p, { force: true });
}

describe('EventQueue', () => {
  const spills: string[] = [];

  beforeEach(() => {
    spills.length = 0;
  });

  afterEach(async () => {
    for (const s of spills) await rmf(s);
  });

  it('delivers enqueued events in order', async () => {
    const delivered: QueuedEvent[] = [];
    const spill = tmpSpill('ok');
    spills.push(spill);
    const q = new EventQueue({
      spillPath: spill,
      poster: async (e) => { delivered.push(e); },
    });
    q.enqueue({ event_type: 'output', content: { chunk: 'a' } });
    q.enqueue({ event_type: 'output', content: { chunk: 'b' } });
    q.enqueue({ event_type: 'output_final', content: { output: 'done' } });
    await q.flush();
    expect(delivered.map((e) => (e.content as any).chunk ?? (e.content as any).output)).toEqual(['a', 'b', 'done']);
    expect(delivered.map((e) => e.sequence_number)).toEqual([0, 1, 2]);
  });

  it('retries on poster failure until success', async () => {
    let attempts = 0;
    const spill = tmpSpill('retry');
    spills.push(spill);
    const q = new EventQueue({
      spillPath: spill,
      baseDelayMs: 1,
      poster: async () => {
        attempts++;
        if (attempts < 3) throw new Error('transient');
      },
    });
    q.enqueue({ event_type: 'output', content: {} });
    await q.flush();
    expect(attempts).toBe(3);
    expect(q.size()).toBe(0);
  });

  it('keeps events buffered after exhausting retries and spills to disk', async () => {
    const spill = tmpSpill('dead');
    spills.push(spill);
    const q = new EventQueue({
      spillPath: spill,
      baseDelayMs: 1,
      maxRetries: 2,
      poster: async () => { throw new Error('server down'); },
    });
    q.enqueue({ event_type: 'output', content: { chunk: 'lost-not-lost' } });
    await q.flush();

    // Event stays in buffer...
    expect(q.size()).toBe(1);
    // ...and is spilled to disk so the next run can retry.
    const raw = await fs.readFile(spill, 'utf8');
    expect(raw).toContain('lost-not-lost');
  });

  it('loads prior spill on startup and replays it', async () => {
    const spill = tmpSpill('replay');
    spills.push(spill);
    await fs.mkdir(path.dirname(spill), { recursive: true });
    const pending: QueuedEvent = {
      event_type: 'output_final',
      content: { output: 'from-prior-run' },
      sequence_number: 42,
    };
    await fs.writeFile(spill, JSON.stringify(pending) + '\n', 'utf8');

    const delivered: QueuedEvent[] = [];
    const q = new EventQueue({
      spillPath: spill,
      poster: async (e) => { delivered.push(e); },
    });
    await q.loadSpill();
    // New enqueue must get a sequence > 42
    const nextSeq = q.enqueue({ event_type: 'output', content: {} });
    expect(nextSeq).toBe(43);
    await q.flush();
    expect(delivered.map((e) => e.sequence_number)).toEqual([42, 43]);
  });

  it('flush() + close() delete the spill when fully drained', async () => {
    const spill = tmpSpill('drain');
    spills.push(spill);
    const q = new EventQueue({
      spillPath: spill,
      poster: async () => {},
    });
    q.enqueue({ event_type: 'output', content: {} });
    await q.close();
    await expect(fs.stat(spill)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('rejects enqueue after close', async () => {
    const spill = tmpSpill('closed');
    spills.push(spill);
    const q = new EventQueue({
      spillPath: spill,
      poster: async () => {},
    });
    await q.close();
    expect(() => q.enqueue({ event_type: 'output', content: {} })).toThrow(/closed/);
  });
});
