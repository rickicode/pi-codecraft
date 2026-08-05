/**
 * Fast Edit — standalone quick_edit / target_edit implementation for Pi.
 *
 * This is a fresh implementation (not a wrapper around pi-snap-edit) that
 * provides the same core editing primitives:
 *   - `quick_edit`: edit by 1-indexed line numbers / ranges.
 *   - `target_edit`: edit by exact literal target text markers.
 *
 * It also exposes `preferFastEditTools()` so the extension can hide the
 * built-in `edit`/`substitute_edit` tools and enable these instead.
 */

import { readFile, writeFile } from "node:fs/promises";
import { Type, type Static } from "@earendil-works/pi-ai";
import { EditErrorCode, EditFailureCandidate, EditFailure, FAST_EDIT_ERROR_MARKER, FastEditError, fail, parseFastEditError } from "./fast-edit/edit-error.js";

// Re-export structured error utilities so consumers can retry failed edits.
export { EditErrorCode, EditFailureCandidate, EditFailure, FAST_EDIT_ERROR_MARKER, FastEditError, parseFastEditError } from "./fast-edit/edit-error.js";

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

const LineEditParams = Type.Object(
	{
		start: Type.Integer({ minimum: 1, description: "1-indexed start line number." }),
		end: Type.Optional(Type.Integer({ minimum: 1, description: "Optional 1-indexed inclusive end line number." })),
		expectedStartLine: Type.Optional(Type.String({ description: "Guard for the current start line content." })),
		expectedStartLineMatch: Type.Optional(
			Type.Union([Type.Literal("exact"), Type.Literal("trim")], {
				description: "exact (default) or trim whitespace matching.",
			}),
		),
		expectedEndLine: Type.Optional(Type.String({ description: "Guard for the current end line content." })),
		expectedLineCount: Type.Optional(
			Type.Integer({ minimum: 1, description: "Expected number of lines in the start..end range." }),
		),
		whitespace: Type.Optional(
			Type.Union([Type.Literal("strict"), Type.Literal("indent_tolerant")], {
				description: "indent_tolerant trims guards and preserves indentation.",
			}),
		),
		preserveIndent: Type.Optional(
			Type.Boolean({ description: "Prefix the start-line indentation to each non-empty replacement line." }),
		),
		lines: Type.Array(Type.String(), { description: "Replacement lines. Empty array deletes the range." }),
	},
	{ description: "Replace, insert, or delete by line number or inclusive range." },
);

const EofEditParams = Type.Object(
	{
		start: Type.Literal("eof", { description: "Append at end of file." }),
		lines: Type.Array(Type.String(), { minItems: 1, description: "Lines to append." }),
	},
	{ description: "Append-only at end of file." },
);

export const QuickEditParams = Type.Object({
	path: Type.String({ description: "Path to the file to edit." }),
	edits: Type.Array(Type.Union([EofEditParams, LineEditParams]), {
		minItems: 1,
		description: 'Line-number edits or EOF appends. Atomic: any invalid edit rejects the whole batch.',
	}),
});

export type QuickEditInput = Static<typeof QuickEditParams>;
export type Edit = QuickEditInput["edits"][number];

const TargetBase = {
	target: Type.String({ minLength: 1, description: "Exact literal target text. Use \\n for multi-line." }),
	matchMode: Type.Optional(
		Type.Union([Type.Literal("exact"), Type.Literal("trim")], {
			description: "exact (default) substring; trim compares whole lines ignoring leading/trailing whitespace.",
		}),
	),
};

export const TargetEditParams = Type.Object({
	path: Type.String({ description: "Path to the file to edit." }),
	ops: Type.Array(
		Type.Union([
			Type.Object({
				type: Type.Literal("replace"),
				...TargetBase,
				line: Type.Optional(Type.Integer({ minimum: 1 })),
				range: Type.Optional(
					Type.Object({
						startLine: Type.Integer({ minimum: 1 }),
						endLine: Type.Integer({ minimum: 1 }),
					}),
				),
				replacement: Type.String({ description: "Replacement text. Use \\n for multi-line." }),
			}),
			Type.Object({
				type: Type.Literal("delete"),
				...TargetBase,
				line: Type.Optional(Type.Integer({ minimum: 1 })),
				range: Type.Optional(
					Type.Object({
						startLine: Type.Integer({ minimum: 1 }),
						endLine: Type.Integer({ minimum: 1 }),
					}),
				),
			}),
			Type.Object({
				type: Type.Literal("insert_before"),
				...TargetBase,
				line: Type.Integer({ minimum: 1 }),
				lines: Type.Array(Type.String(), { minItems: 1 }),
			}),
			Type.Object({
				type: Type.Literal("insert_after"),
				...TargetBase,
				line: Type.Integer({ minimum: 1 }),
				lines: Type.Array(Type.String(), { minItems: 1 }),
			}),
		]),
		{ minItems: 1 },
	),
});

export type TargetEditInput = Static<typeof TargetEditParams>;
export type TargetEditOp = TargetEditInput["ops"][number];

// ---------------------------------------------------------------------------
// LineState helpers for per-operation diff/rebase in target_edit
// ---------------------------------------------------------------------------

export type LineState = { lines: string[]; trailingNewline: boolean };

export function splitToLineState(content: string): LineState {
	const text = splitBom(content).text;
	const trailingNewline = text.endsWith("\n");
	const lines = splitLines(text);
	return { lines, trailingNewline };
}

export function lineStateToString(state: LineState, lineEnding: "\r\n" | "\n" = "\n"): string {
	let text = state.lines.join(lineEnding);
	if (state.trailingNewline && state.lines.length > 0) text += lineEnding;
	return text;
}

export function diffLines(before: LineState, after: LineState): EditDiff | undefined {
	return diffOf(before.lines, after.lines);
}

export function rebasePriorDiffs(diffs: EditDiff[], newStart: number, delta: number): EditDiff[] {
	return diffs.map((d) => (d.newStart >= newStart ? { ...d, newStart: d.newStart + delta } : d));
}

// ---------------------------------------------------------------------------
// Text helpers
// ---------------------------------------------------------------------------

function splitBom(content: string): { bom: boolean; text: string } {
	return content.startsWith("\uFEFF") ? { bom: true, text: content.slice(1) } : { bom: false, text: content };
}

function joinBom(text: string, bom: boolean): string {
	return bom ? `\uFEFF${text}` : text;
}


// ---------------------------------------------------------------------------
// Render summary
// ---------------------------------------------------------------------------
export interface QuickEditRenderSummary {
    added: number;
    removed: number;
}

export function summarizeQuickEditOutput(text: string): QuickEditRenderSummary | undefined {
	const marker = "── diff ──";
	const terminator = "---";
	const outputLines = text.split(/\r?\n/);
	const start = outputLines.findIndex((line) => line === marker);
	if (start === -1) return undefined;

	const end = outputLines.findIndex((line, index) => index > start && line === terminator);
	const lines = end === -1 ? outputLines.slice(start) : outputLines.slice(start, end);
	let added = 0;
	let removed = 0;

	for (const line of lines) {
		if (line.startsWith("+ ")) added++;
		else if (line.startsWith("- ")) removed++;
	}

	if (added === 0 && removed === 0) return undefined;
	return { added, removed };
}
function splitLines(content: string): string[] {
	if (content === "") return [];
	const trimmed = content.endsWith("\n") ? content.slice(0, content.endsWith("\r\n") ? -2 : -1) : content;
	if (trimmed === "") return [];
	return trimmed.split(/\r?\n/);
}

function detectLineEnding(content: string): "\r\n" | "\n" {
	return content.includes("\r\n") ? "\r\n" : "\n";
}

function unescapeLiteral(value: string): string {
	return value.replace(/\\(n|t|r|'|"|`|\\|\n|\$)/g, (match, capturedChar: string) => {
		switch (capturedChar) {
			case "n":
				return "\n";
			case "t":
				return "\t";
			case "r":
				return "\r";
			case "'":
			case '"':
			case "`":
			case "\\":
			case "$":
			case "\n":
				return capturedChar;
			default:
				return match;
		}
	});
}

function lineMatches(actual: string, expected: string, mode: "exact" | "trim"): boolean {
	const compare = mode === "trim" ? (a: string, b: string) => a.trim() === b.trim() : (a: string, b: string) => a === b;
	if (compare(actual, expected)) return true;
	const unescaped = unescapeLiteral(expected);
	if (unescaped !== expected && compare(actual, unescaped)) return true;
	return false;
}

function matchingLineNumbers(lines: string[], expected: string, mode: "exact" | "trim"): number[] {
	const out: number[] = [];
	for (let i = 0; i < lines.length; i++) {
		if (lineMatches(lines[i]!, expected, mode)) out.push(i + 1);
	}
	return out;
}

function leadingIndent(line: string): string {
	return line.match(/^[\t ]*/)?.[0] ?? "";
}

function withPreservedIndent(lines: string[], indent: string): string[] {
	return lines.map((line) => (line === "" ? line : `${indent}${line}`));
}

// ---------------------------------------------------------------------------
// Diff / context formatting
// ---------------------------------------------------------------------------

export const CONTEXT_LINES = 5;

export type EditDiff = { oldStart: number; newStart: number; oldLines: string[]; newLines: string[] };
export type ContextRange = { startIndex: number; endIndex: number };

export function formatDiffs(diffs: EditDiff[]): string {
	if (diffs.length === 0) return "";
	const chunks = ["── diff ──"];
	for (const diff of diffs) {
		const oldEnd = diff.oldStart + Math.max(0, diff.oldLines.length - 1);
		if (diff.oldLines.length <= 1 && diff.newLines.length <= 1) {
			chunks.push(`:${diff.oldStart}`);
		} else {
			const newEnd = diff.newStart + Math.max(0, diff.newLines.length - 1);
			chunks.push(`:${diff.oldStart}-${Math.max(oldEnd, newEnd)}`);
		}
		for (const line of diff.oldLines) chunks.push(`- ${line}`);
		for (const line of diff.newLines) chunks.push(`+ ${line}`);
		chunks.push("");
	}
	return chunks.join("\n").trimEnd();
}

export function formatContexts(lines: string[], ranges: ContextRange[]): string {
	const ordered = ranges
		.filter((r) => r.startIndex < r.endIndex)
		.sort((a, b) => a.startIndex - b.startIndex);
	const merged: ContextRange[] = [];
	for (const range of ordered) {
		const previous = merged.at(-1);
		if (previous && range.startIndex <= previous.endIndex) {
			previous.endIndex = Math.max(previous.endIndex, range.endIndex);
		} else {
			merged.push({ ...range });
		}
	}
	const width = String(lines.length).length;
	return merged
		.map((range) =>
			lines
				.slice(range.startIndex, range.endIndex)
				.map((line, index) => `${String(range.startIndex + index + 1).padStart(width, " ")}| ${line}`)
				.join("\n"),
		)
		.join("\n---\n");
}

// ---------------------------------------------------------------------------
// quick_edit
// ---------------------------------------------------------------------------

type ResolvedEdit = { startLine: number; endLine: number; lines: string[]; insert: boolean };

function resolveMatchMode(edit: Edit, label: string, editIndex: number): "exact" | "trim" {
	if (edit.expectedStartLineMatch) {
		if (edit.expectedStartLineMatch !== "exact" && edit.expectedStartLineMatch !== "trim") {
			fail({ error_code: "VALIDATION", message: `${label} expectedStartLineMatch must be "exact" or "trim"`, edit_index: editIndex });
		}
		return edit.expectedStartLineMatch;
	}
	if (edit.whitespace === "indent_tolerant") return "trim";
	if (edit.whitespace && edit.whitespace !== "strict") {
		fail({ error_code: "VALIDATION", message: `${label} whitespace must be "strict" or "indent_tolerant"`, edit_index: editIndex });
	}
	return "exact";
}

function resolvePreserveIndent(edit: Edit): boolean {
	if (edit.preserveIndent !== undefined) return edit.preserveIndent;
	return edit.whitespace === "indent_tolerant";
}

function validateQuickLineRange(lineCount: number, edit: Edit, label: string, editIndex: number): ResolvedEdit {
	if (edit.start === "eof") {
		if (edit.end !== undefined) {
			fail({ error_code: "INVALID_RANGE", message: `${label} end must not be set when start="eof"`, edit_index: editIndex });
		}
		if (edit.lines.length === 0) {
			fail({ error_code: "VALIDATION", message: `${label} EOF insert must include at least one line`, edit_index: editIndex });
		}
		if (edit.expectedEndLine !== undefined || edit.expectedLineCount !== undefined) {
			fail({
				error_code: "VALIDATION",
				message: `${label} expectedEndLine/expectedLineCount are not valid for start="eof"`,
				edit_index: editIndex,
			});
		}
		return { startLine: lineCount + 1, endLine: lineCount + 1, lines: edit.lines, insert: true };
	}

	const startLine = edit.start;
	if (!Number.isInteger(startLine) || startLine < 1) {
		fail({ error_code: "INVALID_RANGE", message: `${label} start must be a 1-indexed line number`, edit_index: editIndex });
	}
	if (edit.end === undefined && startLine === lineCount + 1) {
		if (edit.lines.length === 0) {
			fail({ error_code: "VALIDATION", message: `${label} EOF insert must include at least one line`, edit_index: editIndex });
		}
		return { startLine, endLine: startLine, lines: edit.lines, insert: true };
	}
	const endLine = edit.end ?? startLine;
	if (!Number.isInteger(endLine) || endLine < 1) {
		fail({ error_code: "INVALID_RANGE", message: `${label} end must be a 1-indexed line number`, edit_index: editIndex, at_line: startLine });
	}
	if (endLine < startLine) {
		fail({ error_code: "INVALID_RANGE", message: `${label} end < start`, edit_index: editIndex, at_line: startLine, end_line: endLine });
	}
	if (startLine > lineCount || endLine > lineCount) {
		fail({
			error_code: "RANGE_OUT_OF_BOUNDS",
			message: `${label} range ${startLine}-${endLine} exceeds ${lineCount} line(s)`,
			edit_index: editIndex,
			at_line: startLine,
			end_line: endLine,
			details: { line_count: lineCount },
		});
	}
	return { startLine, endLine, lines: edit.lines, insert: false };
}

function formatCandidates(lines: string[], matches: number[]): EditFailureCandidate[] {
	return matches.slice(0, 5).map((lineNumber) => ({ line: lineNumber, text: (lines[lineNumber - 1] ?? "").slice(0, 200) }));
}

export async function applyQuickEdits(absolutePath: string, edits: Edit[]): Promise<string> {
	if (edits.length === 0) {
		fail({ error_code: "EMPTY_BATCH", message: "edits must contain at least one replacement" });
	}

	const content = await readFile(absolutePath, "utf8");
	const source = splitBom(content);
	const lines = splitLines(source.text);
	const resolved = edits.map((edit, index) => validateQuickLineRange(lines.length, edit, `edit[${index}]`, index));

	for (let i = 0; i < edits.length; i++) {
		const edit = edits[i]!;
		const resolvedEdit = resolved[i]!;
		const matchMode = resolveMatchMode(edit, `edit[${i}]`, i);

		if (resolvedEdit.insert) continue;

		if (edit.expectedStartLine === undefined) {
			fail({
				error_code: "VALIDATION",
				message: `edit[${i}] expectedStartLine is required (omit only for start="eof")`,
				edit_index: i,
				at_line: resolvedEdit.startLine,
				suggested: { expectedStartLine: lines[resolvedEdit.startLine - 1] ?? "" },
			});
		}

		const actual = lines[resolvedEdit.startLine - 1] ?? "";
		if (!lineMatches(actual, edit.expectedStartLine, matchMode)) {
			const candidates = matchingLineNumbers(lines, edit.expectedStartLine, matchMode);
			const trimCandidates = matchMode === "exact" ? matchingLineNumbers(lines, edit.expectedStartLine, "trim") : [];
			const allCandidates = Array.from(new Set([...candidates, ...trimCandidates]));
			const suggested: Record<string, unknown> = {};
			if (allCandidates.length === 1) {
				suggested.start = allCandidates[0];
				suggested.expectedStartLine = lines[allCandidates[0]! - 1] ?? "";
			}
			if (matchMode === "exact" && trimCandidates.length > 0) {
				suggested.whitespace = "indent_tolerant";
			}
			fail(
				{
					error_code: "EXPECTED_START_LINE_MISMATCH",
					message: `edit[${i}] expectedStartLine mismatch at line ${resolvedEdit.startLine}`,
					edit_index: i,
					at_line: resolvedEdit.startLine,
					actual,
					expected: edit.expectedStartLine,
					candidates: formatCandidates(lines, allCandidates),
					suggested: Object.keys(suggested).length ? suggested : undefined,
				},
				[candidates.length ? `Expected start line found at line(s): ${candidates.join(", ")}` : undefined],
			);
		}

		if (edit.expectedLineCount !== undefined) {
			const actualCount = resolvedEdit.endLine - resolvedEdit.startLine + 1;
			if (actualCount !== edit.expectedLineCount) {
				fail({
					error_code: "EXPECTED_LINE_COUNT_MISMATCH",
					message: `edit[${i}] expectedLineCount mismatch for range ${resolvedEdit.startLine}-${resolvedEdit.endLine}`,
					edit_index: i,
					at_line: resolvedEdit.startLine,
					end_line: resolvedEdit.endLine,
					details: { expected_line_count: edit.expectedLineCount, actual_line_count: actualCount },
					suggested: { expectedLineCount: actualCount },
				});
			}
		}

		if (edit.expectedEndLine !== undefined) {
			const actualEnd = lines[resolvedEdit.endLine - 1] ?? "";
			if (!lineMatches(actualEnd, edit.expectedEndLine, matchMode)) {
				const candidates = matchingLineNumbers(lines, edit.expectedEndLine, matchMode);
				fail({
					error_code: "EXPECTED_END_LINE_MISMATCH",
					message: `edit[${i}] expectedEndLine mismatch at line ${resolvedEdit.endLine}`,
					edit_index: i,
					at_line: resolvedEdit.startLine,
					end_line: resolvedEdit.endLine,
					actual: actualEnd,
					expected: edit.expectedEndLine,
					candidates: formatCandidates(lines, candidates),
				});
			}
		}

		if (resolvePreserveIndent(edit)) {
			resolvedEdit.lines = withPreservedIndent(resolvedEdit.lines, leadingIndent(actual));
		}
	}

	const sortedRanges = resolved.map((r) => [r.startLine, r.endLine] as const).sort((a, b) => a[0] - b[0]);
	for (let i = 1; i < sortedRanges.length; i++) {
		if (sortedRanges[i - 1]![1] >= sortedRanges[i]![0]) {
			fail({
				error_code: "OVERLAPPING_RANGES",
				message: `overlapping edit ranges: ${sortedRanges[i - 1]![0]}-${sortedRanges[i - 1]![1]} and ${sortedRanges[i]![0]}-${sortedRanges[i]![1]}`,
				details: { ranges: [sortedRanges[i - 1], sortedRanges[i]] },
			});
		}
	}

	const oldSnapshots = resolved.map((r) => (r.insert ? [] : lines.slice(r.startLine - 1, r.endLine)));
	const updated = [...lines];
	const order = resolved.map((_, i) => i).sort((a, b) => resolved[b]!.startLine - resolved[a]!.startLine);
	for (const idx of order) {
		const r = resolved[idx]!;
		updated.splice(r.startLine - 1, r.insert ? 0 : r.endLine - r.startLine + 1, ...r.lines);
	}

	const lineEnding = detectLineEnding(source.text);
	const hadTrailingNewline = source.text.endsWith("\n");
	let newContent = updated.join(lineEnding);
	if (hadTrailingNewline && updated.length > 0) newContent += lineEnding;
	await writeFile(absolutePath, joinBom(newContent, source.bom), "utf8");

	const diffs: EditDiff[] = [];
	const contextRanges: ContextRange[] = [];
	let shift = 0;
	for (let i = 0; i < resolved.length; i++) {
		const r = resolved[i]!;
		const newStart = r.startLine + shift;
		diffs.push({ oldStart: r.startLine, newStart, oldLines: oldSnapshots[i]!, newLines: r.lines });
		const changed = Math.max(r.insert ? 0 : r.endLine - r.startLine + 1, r.lines.length);
		contextRanges.push({
			startIndex: Math.max(0, newStart - 1 - CONTEXT_LINES),
			endIndex: Math.min(updated.length, newStart - 1 + changed + CONTEXT_LINES),
		});
		shift += r.lines.length - (r.insert ? 0 : r.endLine - r.startLine + 1);
	}

	const parts: string[] = [];
	const diffOut = formatDiffs(diffs);
	if (diffOut) parts.push(diffOut);
	const ctxOut = formatContexts(updated, contextRanges);
	if (ctxOut) parts.push(ctxOut);
	return parts.join("\n\n");
}

// ---------------------------------------------------------------------------
// target_edit
// ---------------------------------------------------------------------------

type TextLine = { text: string; start: number; end: number }; // end includes trailing newline if present
type Occurrence = { start: number; end: number; startLine: number; endLine: number; kind: "raw" | "fallback" | "trimmed" };

function splitLinesWithOffsets(text: string): TextLine[] {
	const out: TextLine[] = [];
	let start = 0;
	for (let i = 0; i < text.length; i++) {
		if (text[i] === "\n") {
			out.push({ text: text.slice(start, i), start, end: i + 1 });
			start = i + 1;
		}
	}
	if (start < text.length) {
		out.push({ text: text.slice(start), start, end: text.length });
	}
	return out;
}

function lineStartOffsets(textLines: TextLine[]): number[] {
	return textLines.map((l) => l.start);
}

function lineIndexAt(offsets: number[], offset: number): number {
	let index = 0;
	for (let i = 0; i < offsets.length; i++) {
		if (offsets[i]! <= offset) index = i;
		else break;
	}
	return Math.min(index, Math.max(0, offsets.length - 1));
}

function lineOf(offsets: number[], offset: number): number {
	return lineIndexAt(offsets, offset) + 1;
}

function findRawOccurrences(text: string, needle: string): Occurrence[] {
	const out: Occurrence[] = [];
	let pos = text.indexOf(needle);
	while (pos !== -1) {
		out.push({ start: pos, end: pos + needle.length, startLine: 0, endLine: 0, kind: "raw" });
		pos = text.indexOf(needle, pos + Math.max(1, needle.length));
	}
	return out;
}

function trimLeadingLength(s: string): number {
	return s.length - s.trimStart().length;
}

function trimTrailingLength(s: string): number {
	return s.length - s.trimEnd().length;
}

function trimmedTargetLines(target: string): string[] {
	const lines = target.split("\n");
	while (lines.length > 1 && lines[lines.length - 1]!.trim() === "") lines.pop();
	return lines;
}

function findTrimmedOccurrences(text: string, target: string): Occurrence[] {
	const targetLines = trimmedTargetLines(target);
	if (targetLines.length === 0 || !targetLines.some((l) => l.trim().length > 0)) return [];

	const textLines = splitLinesWithOffsets(text);
	const out: Occurrence[] = [];
	for (let i = 0; i <= textLines.length - targetLines.length; i++) {
		let matches = true;
		for (let j = 0; j < targetLines.length; j++) {
			if (textLines[i + j]!.text.trim() !== targetLines[j]!.trim()) {
				matches = false;
				break;
			}
		}
		if (matches) {
			const firstLine = textLines[i]!;
			const lastLine = textLines[i + targetLines.length - 1]!;
			const start = firstLine.start + trimLeadingLength(firstLine.text);
			const hasNewline = lastLine.end > 0 && text[lastLine.end - 1] === "\n";
			const contentEnd = lastLine.end - (hasNewline ? 1 : 0);
			const end = Math.max(start, contentEnd - trimTrailingLength(lastLine.text));
			out.push({ start, end, startLine: 0, endLine: 0, kind: "trimmed" });
		}
	}
	return out;
}

function resolveOccurrenceLines(occurrences: Occurrence[], textLines: TextLine[]) {
	const offsets = lineStartOffsets(textLines);
	for (const o of occurrences) {
		o.startLine = lineOf(offsets, o.start);
		o.endLine = lineOf(offsets, Math.max(o.end - 1, o.start));
	}
}

function findOccurrences(text: string, target: string, matchMode: "exact" | "trim"): { raw: Occurrence[]; fallback: Occurrence[]; trimmed: Occurrence[] } {
	if (matchMode === "trim") {
		const unescaped = unescapeLiteral(target);
		const trimmed = findTrimmedOccurrences(text, target);
		const fallback = unescaped === target ? [] : findTrimmedOccurrences(text, unescaped).map((o) => ({ ...o, kind: "fallback" as const }));
		return { raw: [], fallback, trimmed };
	}
	const raw = findRawOccurrences(text, target);
	const unescaped = unescapeLiteral(target);
	const fallback = unescaped === target ? [] : findRawOccurrences(text, unescaped).map((o) => ({ ...o, kind: "fallback" as const }));
	return { raw, fallback, trimmed: [] };
}

function overlaps(left: Occurrence, right: Occurrence): boolean {
	return left.start < right.end && right.start < left.end;
}

function allOccurrences(groups: { raw: Occurrence[]; fallback: Occurrence[]; trimmed: Occurrence[] }): Occurrence[] {
	const exact = [...groups.raw, ...groups.fallback];
	const trimmed = groups.trimmed.filter((t) => !exact.some((e) => overlaps(e, t)));
	return [...exact, ...trimmed].sort((a, b) => a.start - b.start);
}

function selectOccurrences(
	groups: { raw: Occurrence[]; fallback: Occurrence[]; trimmed: Occurrence[] },
	selector: (o: Occurrence) => boolean,
): Occurrence[] {
	const rawMatches = groups.raw.filter(selector);
	if (rawMatches.length > 0) return rawMatches;
	const fallbackMatches = groups.fallback.filter(selector);
	if (fallbackMatches.length > 0) return fallbackMatches;
	return groups.trimmed.filter(selector);
}

function hasRealContent(target: string): boolean {
	return trimmedTargetLines(target).some((l) => l.trim().length > 0);
}

function validateRangeBounds(range: { startLine: number; endLine: number }, lineCount: number, index: number) {
	if (!Number.isInteger(range.startLine) || range.startLine < 1) {
		fail({ error_code: "VALIDATION", message: `op[${index}] range.startLine must be >= 1`, op_index: index });
	}
	if (!Number.isInteger(range.endLine) || range.endLine < 1) {
		fail({ error_code: "VALIDATION", message: `op[${index}] range.endLine must be >= 1`, op_index: index });
	}
	if (range.endLine < range.startLine) {
		fail({ error_code: "INVALID_RANGE", message: `op[${index}] range end < start`, op_index: index, at_line: range.startLine, end_line: range.endLine });
	}
	if (range.startLine > lineCount || range.endLine > lineCount) {
		fail({
			error_code: "RANGE_OUT_OF_BOUNDS",
			message: `op[${index}] range ${range.startLine}-${range.endLine} exceeds ${lineCount} line(s)`,
			op_index: index,
			at_line: range.startLine,
			end_line: range.endLine,
			details: { line_count: lineCount },
		});
	}
}

function selectedOccurrences(op: TargetEditOp, text: string, textLines: TextLine[], index: number): Occurrence[] {
	if (op.target.length === 0) {
		fail({ error_code: "VALIDATION", message: `op[${index}] target must not be empty`, op_index: index });
	}
	if (op.target.includes("\r")) {
		fail({ error_code: "VALIDATION", message: `op[${index}] target must use \\n line endings, not \\r`, op_index: index });
	}
	if (op.matchMode === "trim" && !hasRealContent(op.target)) {
		fail({ error_code: "VALIDATION", message: `op[${index}] matchMode=trim requires non-whitespace target`, op_index: index });
	}

	const occurrences = findOccurrences(text, op.target, op.matchMode ?? "exact");
	resolveOccurrenceLines(occurrences.raw, textLines);
	resolveOccurrenceLines(occurrences.fallback, textLines);
	resolveOccurrenceLines(occurrences.trimmed, textLines);
	const all = allOccurrences(occurrences);
	if (all.length === 0) {
		fail({ error_code: "TARGET_NOT_FOUND", message: `op[${index}] target not found: ${JSON.stringify(op.target)}`, op_index: index, expected: op.target });
	}

	const lineCount = textLines.length;

	if (op.type === "insert_before" || op.type === "insert_after") {
		if (op.line < 1 || op.line > lineCount) {
			fail({
				error_code: "RANGE_OUT_OF_BOUNDS",
				message: `op[${index}] line ${op.line} is out of bounds`,
				op_index: index,
				at_line: op.line,
				details: { line_count: lineCount },
			});
		}
		const targetIndex = op.line - 1;
		const matches = selectOccurrences(occurrences, (o) => o.startLine <= op.line && o.endLine >= op.line);
		if (matches.length === 0) {
			fail({
				error_code: "TARGET_NOT_FOUND",
				message: `op[${index}] expected 1 occurrence of ${JSON.stringify(op.target)} on line ${op.line} but found 0`,
				op_index: index,
				at_line: op.line,
				expected: op.target,
			});
		}
		if (matches.length > 1) {
			fail({
				error_code: "TARGET_AMBIGUOUS",
				message: `op[${index}] expected 1 occurrence on line ${op.line} but found ${matches.length}`,
				op_index: index,
				at_line: op.line,
				expected: op.target,
				details: { found: matches.length },
				candidates: matches.slice(0, 5).map((o) => ({ line: o.startLine, text: textLines[o.startLine - 1]?.text.slice(0, 200) ?? "", score: 1 })),
			});
		}
		// Adjust occurrence to refer to the requested line only, so insertion position is intuitive.
		const line = textLines[targetIndex];
		return [{ ...matches[0]!, startLine: op.line, endLine: op.line, start: line!.start, end: line!.end }];
	}

	const hasLine = op.line !== undefined;
	const hasRange = op.range !== undefined;

	if (hasLine && !hasRange) {
		if (op.line! < 1 || op.line! > lineCount) {
			fail({ error_code: "RANGE_OUT_OF_BOUNDS", message: `op[${index}] line ${op.line} is out of bounds`, op_index: index, at_line: op.line, details: { line_count: lineCount } });
		}
		const matches = selectOccurrences(occurrences, (o) => o.startLine <= op.line! && o.endLine >= op.line!);
		if (matches.length === 0) {
			fail({ error_code: "TARGET_NOT_FOUND", message: `op[${index}] target not found on line ${op.line}`, op_index: index, at_line: op.line, expected: op.target });
		}
		if (matches.length > 1) {
			fail({
				error_code: "TARGET_AMBIGUOUS",
				message: `op[${index}] target occurs ${matches.length} times on line ${op.line}`,
				op_index: index,
				at_line: op.line,
				expected: op.target,
				details: { found: matches.length },
			});
		}
		return [matches[0]!];
	}

	if (!hasLine && hasRange) {
		validateRangeBounds(op.range!, lineCount, index);
		const rStart = op.range!.startLine - 1;
		const rEnd = op.range!.endLine - 1;
		const matches = selectOccurrences(occurrences, (o) => o.startLine >= rStart + 1 && o.endLine <= rEnd + 1);
		if (matches.length === 0) {
			fail({ error_code: "TARGET_NOT_FOUND", message: `op[${index}] target not found in range ${op.range!.startLine}-${op.range!.endLine}`, op_index: index, at_line: op.range!.startLine, end_line: op.range!.endLine, expected: op.target });
		}
		return matches;
	}

	if (hasLine && hasRange) {
		validateRangeBounds(op.range!, lineCount, index);
		const rStart = op.range!.startLine - 1;
		const rEnd = op.range!.endLine - 1;
		const rangeMatches = selectOccurrences(occurrences, (o) => o.startLine >= rStart + 1 && o.endLine <= rEnd + 1);
		if (rangeMatches.length === 0) {
			fail({ error_code: "TARGET_NOT_FOUND", message: `op[${index}] target not found in range ${op.range!.startLine}-${op.range!.endLine}`, op_index: index, at_line: op.range!.startLine, end_line: op.range!.endLine, expected: op.target });
		}
		const intersecting = rangeMatches.filter((o) => o.startLine <= op.line! && o.endLine >= op.line!);
		if (intersecting.length === 0) {
			fail({ error_code: "TARGET_AMBIGUOUS", message: `op[${index}] range selected ${rangeMatches.length} occurrence(s) but none intersect line ${op.line}`, op_index: index, at_line: op.line, end_line: op.range!.endLine, expected: op.target });
		}
		return rangeMatches;
	}

	if (all.length > 1) {
		fail({
			error_code: "TARGET_AMBIGUOUS",
			message: `op[${index}] target occurs ${all.length} times; provide line or range`,
			op_index: index,
			expected: op.target,
			details: { found: all.length },
			suggested: { line: all[0]!.startLine },
		});
	}
	return [all[0]!];
}

function trimReplacementEdges(replacement: string): string {
	const lines = replacement.split("\n");
	if (lines.length === 0) return replacement;
	lines[0] = lines[0]!.trimStart();
	while (lines.length > 1 && lines[lines.length - 1]!.trim() === "") lines.pop();
	if (lines.length > 0) lines[lines.length - 1] = lines[lines.length - 1]!.trimEnd();
	return lines.join("\n");
}

function diffOf(before: string[], after: string[]): EditDiff | undefined {
	let prefix = 0;
	while (prefix < before.length && prefix < after.length && before[prefix] === after[prefix]) prefix++;
	let suffix = 0;
	while (
		suffix < before.length - prefix &&
		suffix < after.length - prefix &&
		before[before.length - 1 - suffix] === after[after.length - 1 - suffix]
	) {
		suffix++;
	}
	const oldLines = before.slice(prefix, before.length - suffix);
	const newLines = after.slice(prefix, after.length - suffix);
	if (oldLines.length === 0 && newLines.length === 0) return undefined;
	return { oldStart: prefix + 1, newStart: prefix + 1, oldLines, newLines };
}

export async function applyTargetEdits(absolutePath: string, ops: TargetEditOp[]): Promise<string> {
	if (ops.length === 0) {
		fail({ error_code: "EMPTY_BATCH", message: "ops must contain at least one target edit" });
	}

	const content = await readFile(absolutePath, "utf8");
	const source = splitBom(content);
	const lineEnding = detectLineEnding(source.text);
	const trailingNewline = source.text.endsWith("\n");
	const originalLines = splitLines(source.text);
	const originalState: LineState = { lines: originalLines, trailingNewline };

	// Maintain a LineState through each operation. After every op, compute a
	// minimal EditDiff with diffLines(before, after) and rebase prior diffs
	// whenever an op shifts line numbers.
	let state = originalState;
	const priorDiffs: EditDiff[] = [];
	for (const [index, op] of ops.entries()) {
		if (op.type !== "replace" && op.type !== "delete" && op.type !== "insert_before" && op.type !== "insert_after") {
			fail({ error_code: "VALIDATION", message: `op[${index}] unknown type`, op_index: index });
		}

		if (op.type === "replace") {
			if (op.replacement.includes("\r")) fail({ error_code: "VALIDATION", message: `op[${index}] replacement must use \\n, not \\r`, op_index: index });
			if (op.replacement === op.target) fail({ error_code: "VALIDATION", message: `op[${index}] replacement must differ from target`, op_index: index });
		}
		if ((op.type === "insert_before" || op.type === "insert_after") && op.lines.length === 0) {
			fail({ error_code: "VALIDATION", message: `op[${index}] lines must not be empty`, op_index: index });
		}

		// Use the line array without the trailing newline so insertion/deletion math
		// matches the original sequential text implementation.
		const workingText = state.lines.join("\n");
		const textLines = splitLinesWithOffsets(workingText);
		const occurrences = selectedOccurrences(op, workingText, textLines, index);

		// Snapshot before this op for per-op diff computation.
		const beforeState: LineState = { lines: [...state.lines], trailingNewline: state.trailingNewline };

		let text = workingText;
		switch (op.type) {
			case "replace": {
				const effectiveReplacement = op.matchMode === "trim" ? trimReplacementEdges(op.replacement) : unescapeLiteral(op.replacement);
				for (const o of [...occurrences].sort((a, b) => b.start - a.start)) {
					text = `${text.slice(0, o.start)}${effectiveReplacement}${text.slice(o.end)}`;
				}
				break;
			}
			case "delete": {
				for (const o of [...occurrences].sort((a, b) => b.start - a.start)) {
					text = `${text.slice(0, o.start)}${text.slice(o.end)}`;
				}
				break;
			}
			case "insert_before":
			case "insert_after": {
				if (occurrences.length !== 1 || occurrences[0]!.startLine !== occurrences[0]!.endLine) {
					fail({ error_code: "VALIDATION", message: `op[${index}] insert occurrence must resolve to a single line`, op_index: index });
				}
				const o = occurrences[0]!;
				const insertText = op.lines.join("\n");
				if (op.type === "insert_before") {
					text = `${text.slice(0, o.start)}${insertText}\n${text.slice(o.start)}`;
				} else {
					// Insert after the occurrence content and before any terminating newline.
					const position = o.end;
					text = `${text.slice(0, position)}\n${insertText}${text.slice(position)}`;
				}
				break;
			}
		}

		// Update LineState, compute per-op diff, rebase prior diffs if line
		// numbers shifted, and accumulate the result.
		state = { lines: splitLines(text), trailingNewline: state.trailingNewline };
		const opDiff = diffLines(beforeState, state);
		if (opDiff) {
			const delta = opDiff.newLines.length - opDiff.oldLines.length;
			if (delta !== 0) {
				const rebased = rebasePriorDiffs(priorDiffs, opDiff.newStart, delta);
				priorDiffs.length = 0;
				priorDiffs.push(...rebased);
			}
			priorDiffs.push(opDiff);
		}
	}

	const finalLines = state.lines;
	let newContent = finalLines.join(lineEnding);
	if (trailingNewline && finalLines.length > 0) newContent += lineEnding;
	await writeFile(absolutePath, joinBom(newContent, source.bom), "utf8");

	// Build combined output from the accumulated per-op diffs and their contexts.
	const parts: string[] = [];
	const diffOut = formatDiffs(priorDiffs);
	if (diffOut) parts.push(diffOut);
	const contextRanges: ContextRange[] = priorDiffs.map((diff) => ({
		startIndex: Math.max(0, diff.newStart - 1 - CONTEXT_LINES),
		endIndex: Math.min(finalLines.length, diff.newStart - 1 + diff.newLines.length + CONTEXT_LINES),
	}));
	const ctxOut = formatContexts(finalLines, contextRanges);
	if (ctxOut) parts.push(ctxOut);
	return parts.join("\n\n");
}
// ---------------------------------------------------------------------------
// Active tool preference
// ---------------------------------------------------------------------------

export function preferFastEditTools(activeTools: string[]): string[] {
	const withoutDisabled = activeTools.filter((name) => name !== "edit" && name !== "substitute_edit");
	for (const name of ["quick_edit", "target_edit"]) {
		if (!withoutDisabled.includes(name)) withoutDisabled.push(name);
	}
	return withoutDisabled;
}

// ---------------------------------------------------------------------------
// Read output line numbering
// ---------------------------------------------------------------------------

const CONTINUATION_NOTICE = /\r?\n\n(\[(?:Showing lines \d+-\d+ of \d+(?: \([^\]]+\))?\. Use offset=\d+ to continue\.|\d+ more lines in file\. Use offset=\d+ to continue\.)\])$/;

export function numberReadText(text: string, options: { startLine?: number; totalLineCount?: number } = {}): string {
	if (text.startsWith("Read image file ")) return text;
	const noticeMatch = text.match(CONTINUATION_NOTICE);
	const rawBody = noticeMatch ? text.slice(0, noticeMatch.index) : text;
	const nextOffset = noticeMatch ? Number(noticeMatch[1]!.match(/Use offset=(\d+) to continue\./)?.[1]) : undefined;
	const hasRealContinuation = nextOffset === undefined || options.totalLineCount === undefined || nextOffset <= options.totalLineCount;
	const suffix = noticeMatch && hasRealContinuation ? `\n\n${noticeMatch[1]!}` : "";
	const startLine = Number.isInteger(options.startLine) && options.startLine! > 0 ? options.startLine! : 1;
	const body = startLine === 1 ? splitBom(rawBody).text : rawBody;
	const bodyLines = splitLines(body);
	const maxLine = Math.max(startLine + bodyLines.length - 1, options.totalLineCount ?? 0);
	const width = String(maxLine).length;
	const numbered = bodyLines
		.map((line, index) => `${String(startLine + index).padStart(width, " ")}| ${line}`)
		.join("\n");
	return numbered ? `${numbered}${suffix}` : suffix.trimStart();
}
