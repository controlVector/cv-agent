/**
 * Structured Output Parser
 *
 * Parses Claude Code stdout for structured markers emitted by enriched task prompts.
 *
 * Markers:
 *   [THINKING] <text>     → event_type: 'thinking'
 *   [DECISION] <text>     → event_type: 'decision'
 *   [QUESTION] <text>     → event_type: 'question', needs_response: true
 *   [PROGRESS] <text>     → event_type: 'progress'
 *
 * Also detects:
 *   - File write tool use  → event_type: 'file_change'
 *   - Error output          → event_type: 'error'
 */

export interface ParsedEvent {
  eventType: string;
  content: string | Record<string, unknown>;
  needsResponse: boolean;
}

/**
 * Parse a single line of Claude Code output for structured markers.
 * Returns null if the line contains no recognized marker.
 */
export function parseClaudeCodeOutput(line: string): ParsedEvent | null {
  const trimmed = line.trim();
  if (!trimmed) return null;

  // Match [THINKING] ...
  const thinkingMatch = trimmed.match(/^\[THINKING\]\s*(.+)/);
  if (thinkingMatch) {
    return { eventType: 'thinking', content: thinkingMatch[1], needsResponse: false };
  }

  // Match [DECISION] ...
  const decisionMatch = trimmed.match(/^\[DECISION\]\s*(.+)/);
  if (decisionMatch) {
    return { eventType: 'decision', content: decisionMatch[1], needsResponse: false };
  }

  // Match [QUESTION] ...
  const questionMatch = trimmed.match(/^\[QUESTION\]\s*(.+)/);
  if (questionMatch) {
    return { eventType: 'question', content: questionMatch[1], needsResponse: true };
  }

  // Match [PROGRESS] ...
  const progressMatch = trimmed.match(/^\[PROGRESS\]\s*(.+)/);
  if (progressMatch) {
    return { eventType: 'progress', content: progressMatch[1], needsResponse: false };
  }

  // Detect file changes from Claude Code tool use output
  // Patterns: "Created file: ...", "Modified: ...", "Wrote to ...", "Deleted ..."
  const fileChangeMatch = trimmed.match(
    /(?:Created|Modified|Wrote to|Deleted)\s+(?:file:\s*)?(.+)/i,
  );
  if (fileChangeMatch) {
    const action = trimmed.split(/\s/)[0].toLowerCase();
    return {
      eventType: 'file_change',
      content: { path: fileChangeMatch[1].trim(), action },
      needsResponse: false,
    };
  }

  // Detect errors
  const errorMatch = trimmed.match(/^(?:Error|FATAL|FAILED|panic|Traceback)/i);
  if (errorMatch) {
    return { eventType: 'error', content: trimmed, needsResponse: false };
  }

  return null;
}
