/**
 * Tests for output-parser.ts — structured marker detection
 */

import { describe, it, expect } from 'vitest';
import { parseClaudeCodeOutput } from './output-parser';

describe('parseClaudeCodeOutput', () => {
  // ---- Structured markers ----

  it('parses [THINKING] marker', () => {
    const result = parseClaudeCodeOutput('[THINKING] Analyzing the codebase structure');
    expect(result).toEqual({
      eventType: 'thinking',
      content: 'Analyzing the codebase structure',
      needsResponse: false,
    });
  });

  it('parses [DECISION] marker', () => {
    const result = parseClaudeCodeOutput('[DECISION] Using strategy A because it is simpler');
    expect(result).toEqual({
      eventType: 'decision',
      content: 'Using strategy A because it is simpler',
      needsResponse: false,
    });
  });

  it('parses [QUESTION] marker with needsResponse=true', () => {
    const result = parseClaudeCodeOutput('[QUESTION] Should I proceed with the refactor?');
    expect(result).toEqual({
      eventType: 'question',
      content: 'Should I proceed with the refactor?',
      needsResponse: true,
    });
  });

  it('parses [PROGRESS] marker', () => {
    const result = parseClaudeCodeOutput('[PROGRESS] Completed step 1 of 3');
    expect(result).toEqual({
      eventType: 'progress',
      content: 'Completed step 1 of 3',
      needsResponse: false,
    });
  });

  it('handles leading whitespace on markers', () => {
    const result = parseClaudeCodeOutput('   [THINKING] indented thinking');
    expect(result?.eventType).toBe('thinking');
    expect(result?.content).toBe('indented thinking');
  });

  // ---- File change detection ----

  it('detects file creation', () => {
    const result = parseClaudeCodeOutput('Created file: src/new-file.ts');
    expect(result?.eventType).toBe('file_change');
    expect(result?.content).toEqual({ path: 'src/new-file.ts', action: 'created' });
  });

  it('detects file modification', () => {
    const result = parseClaudeCodeOutput('Modified src/existing.ts');
    expect(result?.eventType).toBe('file_change');
    expect(result?.content).toEqual({ path: 'src/existing.ts', action: 'modified' });
  });

  it('detects file deletion', () => {
    const result = parseClaudeCodeOutput('Deleted src/old.ts');
    expect(result?.eventType).toBe('file_change');
    expect(result?.content).toEqual({ path: 'src/old.ts', action: 'deleted' });
  });

  // ---- Error detection ----

  it('detects Error lines', () => {
    const result = parseClaudeCodeOutput('Error: something went wrong');
    expect(result?.eventType).toBe('error');
    expect(result?.content).toBe('Error: something went wrong');
  });

  it('detects FATAL lines', () => {
    const result = parseClaudeCodeOutput('FATAL: out of memory');
    expect(result?.eventType).toBe('error');
  });

  // ---- Non-marker lines (should return null) ----

  it('returns null for empty lines', () => {
    expect(parseClaudeCodeOutput('')).toBeNull();
    expect(parseClaudeCodeOutput('   ')).toBeNull();
  });

  it('returns null for regular text output', () => {
    expect(parseClaudeCodeOutput('## Tastytrade API Validation Report')).toBeNull();
  });

  it('returns null for markdown table lines', () => {
    expect(parseClaudeCodeOutput('| Check | Result |')).toBeNull();
    expect(parseClaudeCodeOutput('|---|---|')).toBeNull();
    expect(parseClaudeCodeOutput('| .env present | Yes |')).toBeNull();
  });

  it('returns null for plain prose output', () => {
    expect(parseClaudeCodeOutput('I have completed the analysis of the repository.')).toBeNull();
    expect(parseClaudeCodeOutput('The test suite passes with 42 tests.')).toBeNull();
    expect(parseClaudeCodeOutput('Here are the results:')).toBeNull();
  });

  it('returns null for code output', () => {
    expect(parseClaudeCodeOutput('function foo() { return 42; }')).toBeNull();
    expect(parseClaudeCodeOutput('const x = await fetch(url);')).toBeNull();
  });

  it('returns null for bullet points', () => {
    expect(parseClaudeCodeOutput('- Fixed the authentication bug')).toBeNull();
    expect(parseClaudeCodeOutput('* Added new endpoint')).toBeNull();
  });

  // ---- Verifies that non-marker lines are NOT silently lost at accumulation layer ----
  // (The actual accumulation is tested via integration in agent.ts;
  //  these tests confirm the parser correctly returns null so the caller can buffer them)

  it('all non-marker lines return null (allowing caller to accumulate them)', () => {
    const nonMarkerLines = [
      '## Summary',
      'All checks passed.',
      '| Metric | Value |',
      '- Step 1 done',
      'Total: 5 files changed',
      '```typescript',
      'export function hello() {}',
      '```',
    ];

    for (const line of nonMarkerLines) {
      const result = parseClaudeCodeOutput(line);
      expect(result).toBeNull();
    }
  });
});
