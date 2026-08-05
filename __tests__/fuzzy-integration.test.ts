import { describe, it, expect } from 'vitest';
import { writeFile, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { applyQuickEdits, applyTargetEdits, FastEditError, FAST_EDIT_ERROR_MARKER } from '../fast-edit.js';

async function tempFile(content: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'pi-codecraft-fuzzy-'));
  const path = join(dir, 'file.txt');
  await writeFile(path, content, 'utf8');
  return path;
}

describe('fuzzy integration', () => {
  it('quick_edit expectedStartLine mismatch includes close matches', async () => {
    const path = await tempFile('hello world\nbeta\ngamma\n');
    try {
      await applyQuickEdits(path, [{ start: 2, expectedStartLine: 'hello worldd', lines: ['BETA'] }]);
    } catch (e: any) {
      expect(e).toBeInstanceOf(FastEditError);
      expect(e.message).toContain(FAST_EDIT_ERROR_MARKER);
      expect(e.message).toContain('expectedStartLine close matches:');
      expect(e.message).toContain('hello world');
    }
  });

  it('quick_edit expectedEndLine mismatch includes close matches', async () => {
    const path = await tempFile('alpha\nhello world\ngamma\n');
    try {
      await applyQuickEdits(path, [{ start: 1, end: 2, expectedStartLine: 'alpha', expectedEndLine: 'hello worldd', lines: ['X'] }]);
    } catch (e: any) {
      expect(e.message).toContain('expectedEndLine close matches:');
      expect(e.message).toContain('hello world');
    }
  });

  it('target_edit TARGET_NOT_FOUND includes fuzzy matches', async () => {
    const path = await tempFile('function one() {}\nfunction two() {}\n');
    try {
      await applyTargetEdits(path, [{ type: 'replace', target: 'function ones()', replacement: 'x' }]);
    } catch (e: any) {
      expect(e.message).toContain('target close matches:');
      expect(e.message).toContain('function one');
    }
  });

  it('target_edit TARGET_NOT_FOUND multi-line includes anchor block hints', async () => {
    const path = await tempFile('begin block\n  body line\nend block\n');
    try {
      await applyTargetEdits(path, [{ type: 'replace', target: 'begin blockk\n  body line\nend block', replacement: 'x' }]);
    } catch (e: any) {
      expect(e.message).toContain('target first line close matches:');
      expect(e.message).toContain('Anchor-block hints');
      expect(e.message).toContain('1-3');
    }
  });
});
