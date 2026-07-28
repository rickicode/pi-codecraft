import { describe, it, expect } from 'vitest';
import { readFile, writeFile, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as fastEdit from '../fast-edit.js';

const { applyQuickEdits, applyTargetEdits, FastEditError, FAST_EDIT_ERROR_MARKER, preferFastEditTools, numberReadText, formatDiffs, formatContexts, summarizeQuickEditOutput } = fastEdit;

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

describe('preferFastEditTools', () => {
  it('removes edit/substitute_edit and ensures quick_edit/target_edit', () => {
    expect(preferFastEditTools(['edit', 'substitute_edit', 'ls'])).toEqual(['ls', 'quick_edit', 'target_edit']);
  });

  it('does not duplicate quick_edit/target_edit', () => {
    expect(preferFastEditTools(['quick_edit', 'target_edit'])).toEqual(['quick_edit', 'target_edit']);
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

describe('summarizeQuickEditOutput', () => {
	it('counts added and removed lines in a diff block', () => {
		const text = `── diff ──\n:2\n- two\n+ TWO\n\nContext lines`;
		const summary = summarizeQuickEditOutput(text);
		expect(summary).toEqual({ added: 1, removed: 1 });
	});

	it('returns undefined when there is no diff marker', () => {
		const text = 'some plain output\nwithout a diff';
		expect(summarizeQuickEditOutput(text)).toBeUndefined();
	});

	it('stops counting at the terminator', () => {
		const text = `── diff ──\n+ added\n- removed\n---\n+ not counted`;
		const summary = summarizeQuickEditOutput(text);
		expect(summary).toEqual({ added: 1, removed: 1 });
	});

	it('returns undefined when there are no +/- lines', () => {
		const text = '── diff ──\n:3\nplain context';
		expect(summarizeQuickEditOutput(text)).toBeUndefined();
	});

	it('counts multiple insertions and deletions', () => {
		const text = `── diff ──\n:2-4\n- a\n- b\n+ x\n+ y\n+ z`;
		expect(summarizeQuickEditOutput(text)).toEqual({ added: 3, removed: 2 });
	});
});
