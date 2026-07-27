export function splitBom(content: string): { bom: boolean; text: string } {
	return content.startsWith("\uFEFF") ? { bom: true, text: content.slice(1) } : { bom: false, text: content };
}

export function joinBom(text: string, bom: boolean): string {
	return bom ? `\uFEFF${text}` : text;
}

export function splitLines(content: string): string[] {
	if (content === "") return [];
	const trimmed = content.endsWith("\n") ? content.slice(0, content.endsWith("\r\n") ? -2 : -1) : content;
	if (trimmed === "") return [];
	return trimmed.split(/\r?\n/);
}

export function detectLineEnding(content: string): "\r\n" | "\n" {
	return content.includes("\r\n") ? "\r\n" : "\n";
}

export function unescapeLiteral(value: string): string {
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

export function leadingIndent(line: string): string {
	return line.match(/^[\t ]*/)?.[0] ?? "";
}

export function withPreservedIndent(lines: string[], indent: string): string[] {
	return lines.map((line) => (line === "" ? line : `${indent}${line}`));
}

export type TextLine = { text: string; start: number; end: number }; // end includes trailing newline if present

export function splitLinesWithOffsets(text: string): TextLine[] {
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

export function lineStartOffsets(textLines: TextLine[]): number[] {
	return textLines.map((l) => l.start);
}

export function lineIndexAt(offsets: number[], offset: number): number {
	let index = 0;
	for (let i = 0; i < offsets.length; i++) {
		if (offsets[i]! <= offset) index = i;
		else break;
	}
	return Math.min(index, Math.max(0, offsets.length - 1));
}

export function lineOf(offsets: number[], offset: number): number {
	return lineIndexAt(offsets, offset) + 1;
}

export function trimLeadingLength(s: string): number {
	return s.length - s.trimStart().length;
}

export function trimTrailingLength(s: string): number {
	return s.length - s.trimEnd().length;
}

export function trimmedTargetLines(target: string): string[] {
	const lines = target.split("\n");
	while (lines.length > 1 && lines[lines.length - 1]!.trim() === "") lines.pop();
	return lines;
}
