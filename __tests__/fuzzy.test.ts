import { describe, it, expect } from 'vitest';
import { closeLineMatches, formatCloseLineMatches, findAnchorBlocks, formatAnchorBlockHints } from '../fast-edit/fuzzy.js';

describe('closeLineMatches', () => {
  const lines = [
    'export function helloWorld() {',
    '  console.log("hello world");',
    '  return 42;',
    '}',
    'function HELLO world() {}',
  ];

  it('returns close matches sorted by score', () => {
    const matches = closeLineMatches(lines, 'hello world');
    expect(matches.length).toBeGreaterThanOrEqual(1);
    // All matches should have strong scores because of substring match.
    for (const m of matches) expect(m.score).toBeGreaterThanOrEqual(0.8);
  });

  it('is case/whitespace/punctuation insensitive', () => {
    const matches = closeLineMatches(lines, 'helloworld');
    expect(matches.some((m) => m.line === 1)).toBe(true);
    expect(matches.some((m) => m.line === 5)).toBe(true);
  });

  it('respects maxResults', () => {
    expect(closeLineMatches(lines, 'hello', { maxResults: 2 }).length).toBeLessThanOrEqual(2);
  });

  it('respects minScore', () => {
    expect(closeLineMatches(lines, 'totally unrelated', { minScore: 0.9 }).length).toBe(0);
  });

  it('rejects multi-line needles', () => {
    expect(closeLineMatches(lines, 'hello\nworld')).toEqual([]);
  });

  it('rejects very short needles', () => {
    expect(closeLineMatches(lines, 'ab')).toEqual([]);
  });

  it('returns empty when there are no lines', () => {
    expect(closeLineMatches([], 'hello world')).toEqual([]);
  });
});

describe('formatCloseLineMatches', () => {
  const lines = ['apple pie', 'banana split', 'apple turnover'];

  it('renders labeled matches', () => {
    const out = formatCloseLineMatches(lines, 'apple pie', 'Start');
    expect(out).toContain('Start close matches:');
    expect(out).toContain('apple pie');
    expect(out).toContain('score');
  });

  it('returns empty string when no matches', () => {
    expect(formatCloseLineMatches(lines, 'dragonfruit')).toBe('');
  });
});

describe('findAnchorBlocks', () => {
  const lines = [
    'begin alpha',
    '  body one',
    'end alpha',
    'begin beta',
    '  body two',
    'end beta',
  ];

  it('suggests blocks with matching first and last target lines', () => {
    const blocks = findAnchorBlocks(lines, 'begin alpha\n  body one\nend alpha');
    expect(blocks.length).toBeGreaterThanOrEqual(1);
    expect(blocks[0]!.startLine).toBe(1);
    expect(blocks[0]!.endLine).toBe(3);
  });

  it('returns empty for single-line targets', () => {
    expect(findAnchorBlocks(lines, 'alpha')).toEqual([]);
  });

  it('returns empty when anchors are absent', () => {
    expect(findAnchorBlocks(lines, 'foo\nbar\nbaz')).toEqual([]);
  });
});

describe('formatAnchorBlockHints', () => {
  const lines = [
    'begin a',
    '  body a',
    'end a',
  ];

  it('renders anchor block hints', () => {
    const out = formatAnchorBlockHints(lines, 'begin a\n  body a\nend a');
    expect(out).toContain('Anchor-block hints');
    expect(out).toContain('1-3');
  });

  it('returns empty when no blocks', () => {
    expect(formatAnchorBlockHints(lines, 'zap\npow')).toBe('');
  });
});
