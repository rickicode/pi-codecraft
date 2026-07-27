import { readFile, writeFile } from "node:fs/promises";
import { type Edit } from "./schemas.js";
import { fail } from "./edit-error.js";
import { splitBom, joinBom, splitLines, detectLineEnding, leadingIndent, withPreservedIndent } from "./text.js";
import { CONTEXT_LINES, type EditDiff, type ContextRange, formatDiffs, formatContexts } from "./diff.js";
import { matchingLineNumbers, lineMatches, formatCandidates } from "./match-helpers.js";

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
