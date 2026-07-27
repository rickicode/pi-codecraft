import { splitBom, splitLines } from "./text.js";

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
