/**
 * Fuzzy close-line matching for fast-edit diagnostics.
 *
 * Adapted from pi-snap-edit/src/fuzzy.ts
 */

export type CloseLineMatch = {
  line: number;
  text: string;
  score: number;
};

export type CloseLineMatchOptions = {
  maxResults?: number;
  minScore?: number;
};

function normalize(value: string): string {
  return value
    .toLowerCase()
    .replace(/\s+/g, "")
    .replace(/[^a-z0-9]/gi, "");
}

function bigrams(value: string): Set<string> {
  const set = new Set<string>();
  for (let i = 0; i < value.length - 1; i++) {
    set.add(value.slice(i, i + 2));
  }
  return set;
}

function diceCoefficient(a: string, b: string): number {
  if (a.length < 2 || b.length < 2) return 0;
  const ga = bigrams(a);
  const gb = bigrams(b);
  if (ga.size === 0 || gb.size === 0) return 0;
  let intersection = 0;
  for (const g of ga) {
    if (gb.has(g)) intersection++;
  }
  return (2 * intersection) / (ga.size + gb.size);
}

function substringOverlap(a: string, b: string): number {
  if (a.length === 0 || b.length === 0) return 0;
  if (a.includes(b) || b.includes(a)) return 1;
  return 0;
}

export function closeLineMatches(
  lines: readonly string[],
  needle: string,
  options: CloseLineMatchOptions = {},
): CloseLineMatch[] {
  const maxResults = options.maxResults ?? 5;
  const minScore = options.minScore ?? 0.6;

  const normalizedNeedle = normalize(needle);
  if (/\r?\n/.test(needle)) return [];
  if (normalizedNeedle.length < 4) return [];

  const matches: CloseLineMatch[] = [];
  for (let i = 0; i < lines.length; i++) {
    const normalizedLine = normalize(lines[i]!);
    if (normalizedLine.length === 0) continue;

    const dice = diceCoefficient(normalizedNeedle, normalizedLine);
    const substring = substringOverlap(normalizedNeedle, normalizedLine);
    const score = Math.max(dice, substring);

    if (score >= minScore) {
      matches.push({ line: i + 1, text: lines[i]!, score });
    }
  }

  matches.sort((a, b) => b.score - a.score || a.line - b.line);
  return matches.slice(0, maxResults);
}

export function formatCloseLineMatches(
  lines: readonly string[],
  needle: string,
  label?: string,
): string {
  const matches = closeLineMatches(lines, needle);
  if (matches.length === 0) return "";

  const header = label ? `${label} close matches:` : "Close matches:";
  const width = String(lines.length).length;
  const body = matches
    .map(
      (m) =>
        `  ${String(m.line).padStart(width, " ")}| ${m.text.slice(0, 120)}  (score ${m.score.toFixed(2)})`,
    )
    .join("\n");
  return `${header}\n${body}`;
}

/**
 * Build anchor-block hints for multi-line targets.
 * Searches for lines matching the first and last target lines (after trim)
 * and returns block ranges where both anchors exist with the same line distance.
 */
export function findAnchorBlocks(
  lines: readonly string[],
  target: string,
  options: CloseLineMatchOptions = {},
): Array<{ startLine: number; endLine: number; score: number }> {
  const targetLines = target.split("\n");
  if (targetLines.length < 2) return [];

  const firstText = targetLines[0]!.trim();
  const lastText = targetLines[targetLines.length - 1]!.trim();
  if (firstText.length < 4 && lastText.length < 4) return [];

  const expectedDistance = targetLines.length - 1;
  const firstMatches = closeLineMatches(lines, firstText, { ...options, maxResults: 50 });
  const lastMatches = closeLineMatches(lines, lastText, { ...options, maxResults: 50 });

  const blocks: Array<{ startLine: number; endLine: number; score: number }> = [];
  for (const first of firstMatches) {
    for (const last of lastMatches) {
      const distance = last.line - first.line;
      if (distance <= 0) continue;
      const score = (distance === expectedDistance ? 1.0 : 0.75) * Math.min(first.score, last.score);
      blocks.push({ startLine: first.line, endLine: last.line, score });
    }
  }

  blocks.sort((a, b) => b.score - a.score || a.startLine - b.startLine);
  return blocks.slice(0, options.maxResults ?? 5);
}

export function formatAnchorBlockHints(
  lines: readonly string[],
  target: string,
): string {
  const blocks = findAnchorBlocks(lines, target);
  if (blocks.length === 0) return "";

  const width = String(lines.length).length;
  const header = "Anchor-block hints (first/last target line matches):";
  const body = blocks
    .map(
      (b) =>
        `  ${String(b.startLine).padStart(width, " ")}-${String(b.endLine).padStart(width, " ")} (score ${b.score.toFixed(2)})`,
    )
    .join("\n");
  return `${header}\n${body}`;
}
