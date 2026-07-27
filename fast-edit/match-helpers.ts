import {
	unescapeLiteral,
	splitLinesWithOffsets,
	trimmedTargetLines,
	trimLeadingLength,
	trimTrailingLength,
	lineStartOffsets,
	lineOf,
	type TextLine,
} from "./text.js";

export function lineMatches(actual: string, expected: string, mode: "exact" | "trim"): boolean {
	const compare = mode === "trim" ? (a: string, b: string) => a.trim() === b.trim() : (a: string, b: string) => a === b;
	if (compare(actual, expected)) return true;
	const unescaped = unescapeLiteral(expected);
	if (unescaped !== expected && compare(actual, unescaped)) return true;
	return false;
}

export function matchingLineNumbers(lines: string[], expected: string, mode: "exact" | "trim"): number[] {
	const out: number[] = [];
	for (let i = 0; i < lines.length; i++) {
		if (lineMatches(lines[i]!, expected, mode)) out.push(i + 1);
	}
	return out;
}

export function formatCandidates(lines: string[], matches: number[]): { line: number; text: string }[] {
	return matches.slice(0, 5).map((lineNumber) => ({ line: lineNumber, text: (lines[lineNumber - 1] ?? "").slice(0, 200) }));
}

export type Occurrence = { start: number; end: number; startLine: number; endLine: number; kind: "raw" | "fallback" | "trimmed" };

export function findRawOccurrences(text: string, needle: string): Occurrence[] {
	const out: Occurrence[] = [];
	let pos = text.indexOf(needle);
	while (pos !== -1) {
		out.push({ start: pos, end: pos + needle.length, startLine: 0, endLine: 0, kind: "raw" });
		pos = text.indexOf(needle, pos + Math.max(1, needle.length));
	}
	return out;
}

export function findTrimmedOccurrences(text: string, target: string): Occurrence[] {
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

export function resolveOccurrenceLines(occurrences: Occurrence[], textLines: TextLine[]) {
	const offsets = lineStartOffsets(textLines);
	for (const o of occurrences) {
		o.startLine = lineOf(offsets, o.start);
		o.endLine = lineOf(offsets, Math.max(o.end - 1, o.start));
	}
}

export function allOccurrences(groups: { raw: Occurrence[]; fallback: Occurrence[]; trimmed: Occurrence[] }): Occurrence[] {
	const exact = [...groups.raw, ...groups.fallback];
	const trimmed = groups.trimmed.filter((t) => !exact.some((e) => overlaps(e, t)));
	return [...exact, ...trimmed].sort((a, b) => a.start - b.start);
}

export function selectOccurrences(
	groups: { raw: Occurrence[]; fallback: Occurrence[]; trimmed: Occurrence[] },
	selector: (o: Occurrence) => boolean,
): Occurrence[] {
	const rawMatches = groups.raw.filter(selector);
	if (rawMatches.length > 0) return rawMatches;
	const fallbackMatches = groups.fallback.filter(selector);
	if (fallbackMatches.length > 0) return fallbackMatches;
	return groups.trimmed.filter(selector);
}

export function hasRealContent(target: string): boolean {
	return trimmedTargetLines(target).some((l) => l.trim().length > 0);
}

function overlaps(left: Occurrence, right: Occurrence): boolean {
	return left.start < right.end && right.start < left.end;
}
