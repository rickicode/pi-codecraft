import { readFile, writeFile } from "node:fs/promises";
import { type TargetEditOp } from "./schemas.js";
import { fail } from "./edit-error.js";
import { splitBom, joinBom, splitLines, splitLinesWithOffsets, detectLineEnding, unescapeLiteral, type TextLine } from "./text.js";
import { CONTEXT_LINES, formatDiffs, formatContexts, type EditDiff } from "./diff.js";
import {
	findRawOccurrences,
	findTrimmedOccurrences,
	resolveOccurrenceLines,
	allOccurrences,
	selectOccurrences,
	hasRealContent,
	type Occurrence,
} from "./match-helpers.js";

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

	// We iterate over ops sequentially. Each op works on the current text state.
	let text = originalLines.join("\n");

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

		const textLines = splitLinesWithOffsets(text);
		const occurrences = selectedOccurrences(op, text, textLines, index);

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
	}

	const finalLines = splitLines(text);
	let newContent = finalLines.join(lineEnding);
	if (trailingNewline && finalLines.length > 0) newContent += lineEnding;
	await writeFile(absolutePath, joinBom(newContent, source.bom), "utf8");

	const diff = diffOf(originalLines, finalLines);
	const parts: string[] = [];
	if (diff) {
		const diffOut = formatDiffs([diff]);
		if (diffOut) parts.push(diffOut);
		const ctxOut = formatContexts(finalLines, [{
			startIndex: Math.max(0, diff.newStart - 1 - CONTEXT_LINES),
			endIndex: Math.min(finalLines.length, diff.newStart - 1 + diff.newLines.length + CONTEXT_LINES),
		}]);
		if (ctxOut) parts.push(ctxOut);
	}
	return parts.join("\n\n");
}
