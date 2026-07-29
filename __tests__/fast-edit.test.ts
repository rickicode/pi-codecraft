import { describe, it, expect } from 'vitest';
import { readFile, writeFile, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as fastEdit from '../fast-edit.js';

const { applyQuickEdits, applyTargetEdits, FastEditError, FAST_EDIT_ERROR_MARKER, parseFastEditError, preferFastEditTools, numberReadText, formatDiffs, formatContexts } = fastEdit;

async function tempFile(content: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'pi-codecraft-test-'));
  const path = join(dir, 'file.txt');
  await writeFile(path, content, 'utf8');
  return path;
}

describe('applyQuickEdits', () => {
  it('applies a valid single-line replacement', async () => {
    const path = await tempFile('one\ntwo\nthree\n');
    const out = await applyQuickEdits(path, [{ start: 2, expectedStartLine: 'two', lines: ['TWO'] }]);
    expect(await readFile(path, 'utf8')).toBe('one\nTWO\nthree\n');
    expect(out).toContain('- two');
    expect(out).toContain('+ TWO');
  });

  it('applies a valid multi-line range replacement', async () => {
    const path = await tempFile('a\nb\nc\nd\n');
    await applyQuickEdits(path, [{ start: 2, end: 3, expectedStartLine: 'b', expectedEndLine: 'c', lines: ['X'] }]);
    expect(await readFile(path, 'utf8')).toBe('a\nX\nd\n');
  });

  it('rejects empty edits batch', async () => {
    const path = await tempFile('a\n');
    await expect(applyQuickEdits(path, [])).rejects.toBeInstanceOf(FastEditError);
  });

  it('rejects expectedStartLine mismatch', async () => {
    const path = await tempFile('a\nb\n');
    await expect(
      applyQuickEdits(path, [{ start: 2, expectedStartLine: 'wrong', lines: ['B'] }]),
    ).rejects.toMatchObject({ failure: { error_code: 'EXPECTED_START_LINE_MISMATCH' } });
  });

  it('rejects expectedLineCount mismatch', async () => {
    const path = await tempFile('a\nb\nc\n');
    await expect(
      applyQuickEdits(path, [{ start: 1, end: 3, expectedStartLine: 'a', expectedLineCount: 2, lines: ['A'] }]),
    ).rejects.toMatchObject({ failure: { error_code: 'EXPECTED_LINE_COUNT_MISMATCH' } });
  });

  it('rejects expectedEndLine mismatch', async () => {
    const path = await tempFile('a\nb\nc\n');
    await expect(
      applyQuickEdits(path, [{ start: 1, end: 3, expectedStartLine: 'a', expectedEndLine: 'z', lines: ['A'] }]),
    ).rejects.toMatchObject({ failure: { error_code: 'EXPECTED_END_LINE_MISMATCH' } });
  });

  it('rejects overlapping ranges', async () => {
    const path = await tempFile('a\nb\nc\nd\n');
    await expect(
      applyQuickEdits(path, [
        { start: 1, end: 2, expectedStartLine: 'a', expectedEndLine: 'b', lines: ['X'] },
        { start: 2, end: 3, expectedStartLine: 'b', expectedEndLine: 'c', lines: ['Y'] },
      ]),
    ).rejects.toMatchObject({ failure: { error_code: 'OVERLAPPING_RANGES' } });
  });

  it('inserts at line after existing end with start=lineCount+1', async () => {
    const path = await tempFile('a\nb\n');
    await applyQuickEdits(path, [{ start: 3, expectedStartLine: 'b', lines: ['c'] }]);
    expect(await readFile(path, 'utf8')).toBe('a\nb\nc\n');
  });

  it('appends at EOF using start="eof"', async () => {
    const path = await tempFile('a\nb\n');
    await applyQuickEdits(path, [{ start: 'eof', lines: ['c', 'd'] }]);
    expect(await readFile(path, 'utf8')).toBe('a\nb\nc\nd\n');
  });

  it('deletes a range when lines is empty', async () => {
    const path = await tempFile('a\nb\nc\n');
    await applyQuickEdits(path, [{ start: 2, expectedStartLine: 'b', lines: [] }]);
    expect(await readFile(path, 'utf8')).toBe('a\nc\n');
  });

  it('preserves BOM', async () => {
    const path = await tempFile('\uFEFFone\ntwo\n');
    await applyQuickEdits(path, [{ start: 2, expectedStartLine: 'two', lines: ['TWO'] }]);
    const content = await readFile(path, 'utf8');
    expect(content.startsWith('\uFEFF')).toBe(true);
    expect(content).toBe('\uFEFFone\nTWO\n');
  });

  it('preserves CRLF line endings', async () => {
    const path = await tempFile('one\r\ntwo\r\n');
    await applyQuickEdits(path, [{ start: 2, expectedStartLine: 'two', lines: ['TWO'] }]);
    expect(await readFile(path, 'utf8')).toBe('one\r\nTWO\r\n');
  });

  it('supports indent_tolerant whitespace', async () => {
    const path = await tempFile('    one\n    two\n');
    await applyQuickEdits(path, [{
      start: 2,
      expectedStartLine: 'two',
      whitespace: 'indent_tolerant',
      lines: ['TWO'],
    }]);
    expect(await readFile(path, 'utf8')).toBe('    one\n    TWO\n');
  });

  it('supports preserveIndent', async () => {
    const path = await tempFile('  a\n  b\n');
    await applyQuickEdits(path, [{
      start: 2,
      expectedStartLine: '  b',
      preserveIndent: true,
      lines: ['x', 'y'],
    }]);
    expect(await readFile(path, 'utf8')).toBe('  a\n  x\n  y\n');
  });

  it('rejects out-of-bounds range', async () => {
    const path = await tempFile('a\nb\n');
    await expect(
      applyQuickEdits(path, [{ start: 5, expectedStartLine: 'x', lines: ['X'] }]),
    ).rejects.toMatchObject({ failure: { error_code: 'RANGE_OUT_OF_BOUNDS' } });
  });

  it('rejects end < start', async () => {
    const path = await tempFile('a\nb\nc\n');
    await expect(
      applyQuickEdits(path, [{ start: 3, end: 1, expectedStartLine: 'c', lines: ['X'] }]),
    ).rejects.toMatchObject({ failure: { error_code: 'INVALID_RANGE' } });
  });
});

describe('applyTargetEdits', () => {
  it('replaces a literal target', async () => {
    const path = await tempFile('hello world\n');
    await applyTargetEdits(path, [{ type: 'replace', target: 'hello', replacement: 'hi' }]);
    expect(await readFile(path, 'utf8')).toBe('hi world\n');
  });

  it('replaces target on a specific line', async () => {
    const path = await tempFile('foo\nbar foo\nfoo\n');
    await applyTargetEdits(path, [{ type: 'replace', target: 'foo', line: 2, replacement: 'baz' }]);
    expect(await readFile(path, 'utf8')).toBe('foo\nbar baz\nfoo\n');
  });

  it('replaces target within a specific range', async () => {
    const path = await tempFile('a\nb\nc\nb\ne\n');
    await applyTargetEdits(path, [{ type: 'replace', target: 'b', range: { startLine: 2, endLine: 4 }, replacement: 'B' }]);
    expect(await readFile(path, 'utf8')).toBe('a\nB\nc\nB\ne\n');
  });

  it('deletes a target', async () => {
    const path = await tempFile('one two three\n');
    await applyTargetEdits(path, [{ type: 'delete', target: 'two ' }]);
    expect(await readFile(path, 'utf8')).toBe('one three\n');
  });

  it('inserts before a target line', async () => {
    const path = await tempFile('alpha\nbeta\n');
    await applyTargetEdits(path, [{ type: 'insert_before', target: 'beta', line: 2, lines: ['gamma'] }]);
    expect(await readFile(path, 'utf8')).toBe('alpha\ngamma\nbeta\n');
  });

  it('inserts after a target line', async () => {
    const path = await tempFile('alpha\nbeta\n');
    await applyTargetEdits(path, [{ type: 'insert_after', target: 'beta', line: 2, lines: ['gamma'] }]);
    expect(await readFile(path, 'utf8')).toBe('alpha\nbeta\ngamma\n');
  });

  it('returns per-op diffs for sequential replacements', async () => {
    const path = await tempFile('a\nb\nc\nd\n');
    const out = await applyTargetEdits(path, [
      { type: 'replace', target: 'b', replacement: 'B' },
      { type: 'replace', target: 'c', replacement: 'C' },
    ]);
    expect(await readFile(path, 'utf8')).toBe('a\nB\nC\nd\n');
    expect(out).toContain('- b');
    expect(out).toContain('+ B');
    expect(out).toContain('- c');
    expect(out).toContain('+ C');
  });

  it('rebases later diff line numbers when earlier op inserts lines', async () => {
    const path = await tempFile('a\nb\nc\nd\n');
    const out = await applyTargetEdits(path, [
      { type: 'insert_before', target: 'b', line: 2, lines: ['X'] },
      { type: 'replace', target: 'c', replacement: 'C' },
    ]);
    expect(await readFile(path, 'utf8')).toBe('a\nX\nb\nC\nd\n');
    expect(out).toContain('+ X');
    expect(out).toContain('+ C');
    expect(out).toMatch(/:4/);
  });

  it('rebases later diffs when earlier op deletes lines', async () => {
    const path = await tempFile('a\nb\nc\nd\ne\n');
    const out = await applyTargetEdits(path, [
      { type: 'delete', target: 'b' + '\n' },
      { type: 'replace', target: 'd', replacement: 'D' },
    ]);
    expect(await readFile(path, 'utf8')).toBe('a\nc\nD\ne\n');
    expect(out).toContain('- b');
    expect(out).toContain('+ D');
    expect(out).toMatch(/:3/);
  });

  it('reports TARGET_NOT_FOUND', async () => {
    const path = await tempFile('abc\n');
    await expect(
      applyTargetEdits(path, [{ type: 'replace', target: 'xyz', replacement: 'X' }]),
    ).rejects.toMatchObject({ failure: { error_code: 'TARGET_NOT_FOUND' } });
  });

  it('reports TARGET_AMBIGUOUS without line/range', async () => {
    const path = await tempFile('foo\nfoo\n');
    await expect(
      applyTargetEdits(path, [{ type: 'replace', target: 'foo', replacement: 'bar' }]),
    ).rejects.toMatchObject({ failure: { error_code: 'TARGET_AMBIGUOUS' } });
  });

  it('reports TARGET_AMBIGUOUS on line with multiple matches', async () => {
    const path = await tempFile('foo foo\n');
    await expect(
      applyTargetEdits(path, [{ type: 'replace', target: 'foo', line: 1, replacement: 'bar' }]),
    ).rejects.toMatchObject({ failure: { error_code: 'TARGET_AMBIGUOUS' } });
  });

  it('supports multi-line targets', async () => {
    const path = await tempFile('start\nfoo\nbar\nend\n');
    await applyTargetEdits(path, [{ type: 'replace', target: 'foo\nbar', replacement: 'baz\nqux' }]);
    expect(await readFile(path, 'utf8')).toBe('start\nbaz\nqux\nend\n');
  });

  it('supports trim match mode', async () => {
    const path = await tempFile('  hello world  \n');
    await applyTargetEdits(path, [{ type: 'replace', target: 'hello world', matchMode: 'trim', replacement: 'hi' }]);
    expect(await readFile(path, 'utf8')).toBe('  hi  \n');
  });

  it('rejects replacement containing \\r', async () => {
    const path = await tempFile('a\n');
    await expect(
      applyTargetEdits(path, [{ type: 'replace', target: 'a', replacement: 'x\ry' }]),
    ).rejects.toMatchObject({ failure: { error_code: 'VALIDATION' } });
  });

  it('rejects replacement same as target', async () => {
    const path = await tempFile('a\n');
    await expect(
      applyTargetEdits(path, [{ type: 'replace', target: 'a', replacement: 'a' }]),
    ).rejects.toMatchObject({ failure: { error_code: 'VALIDATION' } });
  });
});

describe('FastEditError', () => {
  it('serializes failure details into the message', () => {
    const err = new FastEditError({ error_code: 'VALIDATION', message: 'bad input' });
    expect(err.message).toContain(FAST_EDIT_ERROR_MARKER);
    expect(err.message).toContain('"error_code":"VALIDATION"');
    expect(err.failure.error_code).toBe('VALIDATION');
  });
});


describe('parseFastEditError', () => {
  it('parses a FastEditError instance', () => {
    const failure: fastEdit.EditFailure = { error_code: 'VALIDATION', message: 'bad input' };
    const parsed = parseFastEditError(new FastEditError(failure));
    expect(parsed).toEqual(expect.objectContaining(failure));
  });

  it('parses a plain string containing the marker', () => {
    const failure = { error_code: 'TARGET_NOT_FOUND', message: 'target missing' };
    const err = `oops\n${FAST_EDIT_ERROR_MARKER}\n${JSON.stringify(failure)}`;
    const parsed = parseFastEditError(err);
    expect(parsed).toEqual(expect.objectContaining(failure));
  });

  it('parses a generic Error whose message contains the marker', () => {
    const failure = { error_code: 'RANGE_OUT_OF_BOUNDS', message: 'range bad' };
    const err = new Error(`context\n${FAST_EDIT_ERROR_MARKER}\n${JSON.stringify(failure)}`);
    const parsed = parseFastEditError(err);
    expect(parsed).toEqual(expect.objectContaining(failure));
  });

  it('returns undefined when the marker is missing', () => {
    expect(parseFastEditError('something went wrong')).toBeUndefined();
    expect(parseFastEditError(new Error('something went wrong'))).toBeUndefined();
  });

  it('returns undefined for invalid JSON after the marker', () => {
    const err = `prefix\n${FAST_EDIT_ERROR_MARKER}\nnot-json{`;
    expect(parseFastEditError(err)).toBeUndefined();
  });

  it('parses a valid payload after an invalid earlier marker', () => {
    const failure: fastEdit.EditFailure = { error_code: 'TARGET_NOT_FOUND', message: 'target missing' };
    const err = `bad\n${FAST_EDIT_ERROR_MARKER}\nnot-json\n---\n${FAST_EDIT_ERROR_MARKER}\n${JSON.stringify(failure)}`;
    expect(parseFastEditError(err)).toEqual(expect.objectContaining(failure));
  });

  it('returns undefined for non-error non-string inputs', () => {
    expect(parseFastEditError(null)).toBeUndefined();
    expect(parseFastEditError(42)).toBeUndefined();
    expect(parseFastEditError({ error_code: 'TARGET_NOT_FOUND' })).toBeUndefined();
  });
});
describe('preferFastEditTools', () => {
  it('removes edit/substitute_edit and ensures quick_edit/target_edit', () => {
    expect(preferFastEditTools(['edit', 'substitute_edit', 'ls'])).toEqual(['ls', 'quick_edit', 'target_edit', 'substitute_edit']);
  });

  it('does not duplicate quick_edit/target_edit', () => {
    expect(preferFastEditTools(['quick_edit', 'target_edit'])).toEqual(['quick_edit', 'target_edit', 'substitute_edit']);
  });
});

describe('numberReadText', () => {
  it('numbers lines starting from 1', () => {
    expect(numberReadText('a\nb\nc')).toBe('1| a\n2| b\n3| c');
  });

  it('respects startLine option', () => {
    expect(numberReadText('b\nc', { startLine: 5 })).toBe('5| b\n6| c');
  });

  it('strips image prefixes unchanged', () => {
    expect(numberReadText('Read image file foo')).toBe('Read image file foo');
  });

  it('preserves continuation notice', () => {
    const notice = '[Output truncated]\n\n[Showing lines 1-10 of 100. Use offset=11 to continue.]';
    expect(numberReadText(notice)).toContain('Use offset=11 to continue.');
  });
});

describe('formatDiffs', () => {
  it('formats single-line diff', () => {
    const out = formatDiffs([{ oldStart: 2, newStart: 2, oldLines: ['old'], newLines: ['new'] }]);
    expect(out).toContain(':2');
    expect(out).toContain('- old');
    expect(out).toContain('+ new');
  });

  it('returns empty for empty diffs', () => {
    expect(formatDiffs([])).toBe('');
  });
});

describe('formatContexts', () => {
  it('renders numbered context lines', () => {
    const out = formatContexts(['a', 'b', 'c'], [{ startIndex: 0, endIndex: 3 }]);
    expect(out).toContain('1| a');
    expect(out).toContain('2| b');
  });

  it('merges overlapping ranges', () => {
    const out = formatContexts(['a', 'b', 'c', 'd'], [
      { startIndex: 0, endIndex: 2 },
      { startIndex: 1, endIndex: 4 },
    ]);
    expect(out).toContain('1| a');
    expect(out).toContain('4| d');
  });
});

describe('applySubstituteEdits', () => {
  it('applies a single literal substitution within range', async () => {
    const path = await tempFile('one\ntwo\nthree\n');
    const out = await fastEdit.applySubstituteEdits(path, {
      path,
      start: 1,
      end: 3,
      substitutions: [{ old: 'two', new: 'TWO', count: 1 }],
    });
    expect(await readFile(path, 'utf8')).toBe('one\nTWO\nthree\n');
    expect(out).toContain('- two');
    expect(out).toContain('+ TWO');
  });

  it('applies multiple ordered substitutions', async () => {
    const path = await tempFile('a b c\na b c\n');
    await fastEdit.applySubstituteEdits(path, {
      path,
      start: 1,
      end: 2,
      substitutions: [
        { old: 'a', new: 'x', count: 2 },
        { old: 'b', new: 'y', count: 2 },
      ],
    });
    expect(await readFile(path, 'utf8')).toBe('x y c\nx y c\n');
  });

  it('allows later substitutions to match text produced by earlier ones', async () => {
    const path = await tempFile('foo bar\n');
    await fastEdit.applySubstituteEdits(path, {
      path,
      start: 1,
      end: 1,
      substitutions: [
        { old: 'foo', new: 'baz', count: 1 },
        { old: 'baz bar', new: 'hello', count: 1 },
      ],
    });
    expect(await readFile(path, 'utf8')).toBe('hello\n');
  });

  it('rejects count mismatch', async () => {
    const path = await tempFile('x\nx\nx\n');
    await expect(
      fastEdit.applySubstituteEdits(path, {
        path,
        start: 1,
        end: 3,
        substitutions: [{ old: 'x', new: 'y', count: 2 }],
      }),
    ).rejects.toMatchObject({ failure: { error_code: 'VALIDATION' } });
  });

  it('respects start/end range boundaries', async () => {
    const path = await tempFile('x\nx\nx\n');
    await fastEdit.applySubstituteEdits(path, {
      path,
      start: 2,
      end: 3,
      substitutions: [{ old: 'x', new: 'y', count: 2 }],
    });
    expect(await readFile(path, 'utf8')).toBe('x\ny\ny\n');
  });

  it('rejects empty old', async () => {
    const path = await tempFile('abc\n');
    await expect(
      fastEdit.applySubstituteEdits(path, {
        path,
        start: 1,
        end: 1,
        substitutions: [{ old: '', new: 'x', count: 1 }],
      }),
    ).rejects.toMatchObject({ failure: { error_code: 'VALIDATION' } });
  });

  it('rejects old === new', async () => {
    const path = await tempFile('abc\n');
    await expect(
      fastEdit.applySubstituteEdits(path, {
        path,
        start: 1,
        end: 1,
        substitutions: [{ old: 'a', new: 'a', count: 1 }],
      }),
    ).rejects.toMatchObject({ failure: { error_code: 'VALIDATION' } });
  });

  it('rejects multi-line old', async () => {
    const path = await tempFile('abc\n');
    await expect(
      fastEdit.applySubstituteEdits(path, {
        path,
        start: 1,
        end: 1,
        substitutions: [{ old: 'a\nb', new: 'x', count: 1 }],
      }),
    ).rejects.toMatchObject({ failure: { error_code: 'VALIDATION' } });
  });

  it('preserves BOM', async () => {
    const path = await tempFile('\uFEFFone\ntwo\n');
    await fastEdit.applySubstituteEdits(path, {
      path,
      start: 1,
      end: 2,
      substitutions: [{ old: 'one', new: 'ONE', count: 1 }],
    });
    const content = await readFile(path, 'utf8');
    expect(content.startsWith('\uFEFF')).toBe(true);
    expect(content).toBe('\uFEFFONE\ntwo\n');
  });

  it('preserves CRLF line endings', async () => {
    const path = await tempFile('one\r\ntwo\r\n');
    await fastEdit.applySubstituteEdits(path, {
      path,
      start: 1,
      end: 2,
      substitutions: [{ old: 'two', new: 'TWO', count: 1 }],
    });
    expect(await readFile(path, 'utf8')).toBe('one\r\nTWO\r\n');
  });

  it('rejects range out of bounds', async () => {
    const path = await tempFile('a\nb\n');
    await expect(
      fastEdit.applySubstituteEdits(path, {
        path,
        start: 1,
        end: 5,
        substitutions: [{ old: 'a', new: 'b', count: 1 }],
      }),
    ).rejects.toMatchObject({ failure: { error_code: 'RANGE_OUT_OF_BOUNDS' } });
  });
});
