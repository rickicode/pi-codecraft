/**
 * Pi CodeCraft Extension
 *
 * A rich set of search, edit, and guardrail tools for pi sessions:
 *   - `rg` instead of built-in `grep`
 *   - `fd` instead of built-in `find` / naive `ls`
 *   - `ast_grep` for structure-aware code search and rewrite
 *   - `format_file` to run Prettier or Biome automatically
 *   - `git_status` to inspect repo state before finishing
 *   - `trash` to move deleted files/folders to /tmp (no `rm`)
 *   - `quick_edit` / `target_edit` via fast-edit (standalone editing tools)
 *   - Injected system-prompt rules that tell the model to avoid
 *     `apply_patch`, built-in grep/find, destructive rm, and to use
 *     git/format/trash tools.
 *
 * Usage:
 *   pi -e /workspaces/pi-codecraft/extension.ts
 *
 * Or copy this file (and optionally this whole folder) to
 *   ~/.pi/agent/extensions/pi-codecraft.ts
 * so it is loaded automatically in every session.
 */

import { execFile } from "node:child_process/promises";
import { mkdtemp, writeFile, access, readFile } from "node:fs/promises";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Type } from "@earendil-works/pi-ai";
import {
	applyQuickEdits,
	applyTargetEdits,
	preferFastEditTools,
	numberReadText,
	QuickEditParams,
	TargetEditParams,
} from "./fast-edit/index.js";
import {
	isToolCallEventType,
	DEFAULT_MAX_BYTES,
	DEFAULT_MAX_LINES,
	formatSize,
	truncateHead,
	withFileMutationQueue,
	type BuildSystemPromptOptions,
	type ExtensionAPI,
	type TruncationResult,
} from "@earendil-works/pi-coding-agent";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface RunResult {
	stdout: string;
	stderr: string;
}

async function runCommand(
	binaries: string[],
	args: string[],
	cwd: string,
	signal?: AbortSignal,
): Promise<RunResult> {
	let lastError: Error | undefined;

	for (const binary of binaries) {
		try {
			return await execFile(binary, args, { cwd, signal });
		} catch (err: any) {
			lastError = err;
			// If the binary is missing, try the next alias.
			if (err.code === "ENOENT" || err.errno === -2) {
				continue;
			}
			// Otherwise, rethrow the error from this binary.
			throw err;
		}
	}

	throw new Error(
		`Command not found: tried ${binaries.map((b) => `"${b}"`).join(", ")}. ${lastError?.message ?? ""}`,
	);
}

async function writeTruncatedOutput(
	output: string,
	truncation: TruncationResult,
	prefix: string,
): Promise<{ text: string; fullOutputPath: string }> {
	const tempDir = await mkdtemp(join(tmpdir(), prefix));
	const fullOutputPath = join(tempDir, "output.txt");
	await withFileMutationQueue(fullOutputPath, async () => {
		await writeFile(fullOutputPath, output, "utf8");
	});

	const truncatedLines = truncation.totalLines - truncation.outputLines;
	const truncatedBytes = truncation.totalBytes - truncation.outputBytes;

	const notice = `\n\n[Output truncated: showing ${truncation.outputLines} of ${truncation.totalLines} lines (${formatSize(
		truncation.outputBytes,
	)} of ${formatSize(truncation.totalBytes)}). ${truncatedLines} lines (${formatSize(
		truncatedBytes,
	)}) omitted. Full output saved to: ${fullOutputPath}]`;

	return { text: truncation.content + notice, fullOutputPath };
}

async function maybeTruncate(
	output: string,
	prefix: string,
): Promise<{ text: string; fullOutputPath?: string }> {
	const truncation = truncateHead(output, {
		maxLines: DEFAULT_MAX_LINES,
		maxBytes: DEFAULT_MAX_BYTES,
	});

	if (!truncation.truncated) {
		return { text: truncation.content };
	}

	const { text, fullOutputPath } = await writeTruncatedOutput(output, truncation, prefix);
	return { text, fullOutputPath };
}

/**
 * Resolve a user-supplied path relative to the extension context's cwd.
 */
function resolvePath(ctx: { cwd: string }, rel: string): string {
	return resolve(ctx.cwd, rel);
}

// ---------------------------------------------------------------------------
// rg — ripgrep content search
// ---------------------------------------------------------------------------

const RgParams = Type.Object({
	pattern: Type.String({ description: "Search pattern (regex)" }),
	path: Type.Optional(Type.String({ description: "Directory or file to search (default: cwd)" })),
	glob: Type.Optional(Type.String({ description: "File glob, e.g. '*.ts'" })),
	context: Type.Optional(Type.Number({ description: "Number of context lines around each match" })),
	maxCount: Type.Optional(Type.Number({ description: "Stop after this many matches per file" })),
});

function registerRg(pi: ExtensionAPI) {
	pi.registerTool({
		name: "rg",
		label: "ripgrep",
		description:
			"Fast content search using ripgrep. Prefer this over the built-in `grep` tool. Output is truncated automatically; full output is saved to a temp file when needed.",
		parameters: RgParams,
		promptGuidelines: [
			"Use `rg` instead of the built-in `grep` tool for searching file contents.",
			"Use `glob` to narrow file scope instead of searching the whole repository.",
		],
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			const searchPath = resolvePath(ctx, params.path || ".");
			const args = ["--line-number", "--color=never", "--heading"];

			if (params.context !== undefined && params.context > 0) {
				args.push("-C", String(params.context));
			}
			if (params.maxCount !== undefined && params.maxCount > 0) {
				args.push("-m", String(params.maxCount));
			}
			if (params.glob) {
				args.push("--glob", params.glob);
			}

			args.push(params.pattern, searchPath);

			let output: string;
			try {
				const { stdout } = await runCommand(["rg"], args, ctx.cwd, signal);
				output = stdout;
			} catch (err: any) {
				if (err.code === 1 && !err.stderr) {
					return {
						content: [{ type: "text", text: "No matches found" }],
						details: { pattern: params.pattern, path: params.path, matchCount: 0 },
					};
				}
				throw new Error(`ripgrep failed: ${err.message}`);
			}

			if (!output.trim()) {
				return {
					content: [{ type: "text", text: "No matches found" }],
					details: { pattern: params.pattern, path: params.path, matchCount: 0 },
				};
			}

			const { text, fullOutputPath } = await maybeTruncate(output, "pi-rg-");
			const matchCount = output.split("\n").filter((l) => l.trim()).length;

			return {
				content: [{ type: "text", text }],
				details: {
					pattern: params.pattern,
					path: params.path,
					matchCount,
					fullOutputPath,
				},
			};
		},
	});
}

// ---------------------------------------------------------------------------
// fd — fast file/directory discovery
// ---------------------------------------------------------------------------

const FdParams = Type.Object({
	pattern: Type.Optional(Type.String({ description: "Optional filename/regex pattern" })),
	path: Type.Optional(Type.String({ description: "Directory to search (default: cwd)" })),
	type: Type.Optional(
		Type.Union([Type.Literal("file"), Type.Literal("directory"), Type.Literal("any")], {
			description: "Search files, directories, or both",
		}),
	),
	extension: Type.Optional(Type.String({ description: "File extension, e.g. 'ts'" })),
	maxDepth: Type.Optional(Type.Number({ description: "Maximum directory depth" })),
});

function registerFd(pi: ExtensionAPI) {
	pi.registerTool({
		name: "fd",
		label: "fd",
		description:
			"Fast file/directory discovery using fd. Prefer this over the built-in `find` tool or running `ls -R`.",
		parameters: FdParams,
		promptGuidelines: [
			"Use `fd` instead of the built-in `find` tool to locate files and directories.",
			"Use `extension` or `type` to narrow results instead of post-filtering with grep.",
		],
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			const searchPath = resolvePath(ctx, params.path || ".");
			const args = ["--color=never"];

			if (params.type && params.type !== "any") {
				args.push("--type", params.type === "directory" ? "d" : "f");
			}
			if (params.extension) {
				args.push("--extension", params.extension);
			}
			if (params.maxDepth !== undefined && params.maxDepth >= 0) {
				args.push("--max-depth", String(params.maxDepth));
			}

			args.push(params.pattern || "", searchPath);

			let output: string;
			try {
				const { stdout } = await runCommand(["fd", "fdfind"], args, ctx.cwd, signal);
				output = stdout;
			} catch (err: any) {
				if (err.code === 1 && !err.stderr) {
					return {
						content: [{ type: "text", text: "No matches found" }],
						details: { path: params.path, matchCount: 0 },
					};
				}
				throw new Error(`fd failed: ${err.message}`);
			}

			if (!output.trim()) {
				return {
					content: [{ type: "text", text: "No matches found" }],
					details: { path: params.path, matchCount: 0 },
				};
			}

			const { text, fullOutputPath } = await maybeTruncate(output, "pi-fd-");
			const matchCount = output.split("\n").filter((l) => l.trim()).length;

			return {
				content: [{ type: "text", text }],
				details: {
					path: params.path,
					matchCount,
					fullOutputPath,
				},
			};
		},
	});
}

// ---------------------------------------------------------------------------
// ast_grep — AST-based search / rewrite
// ---------------------------------------------------------------------------

const AstGrepParams = Type.Object({
	mode: Type.Optional(
		Type.Union([Type.Literal("run"), Type.Literal("scan")], {
			description: "Use 'run' for ad-hoc patterns, 'scan' for YAML rule files",
		}),
	),
	pattern: Type.Optional(Type.String({ description: "AST pattern (required for run mode)" })),
	rewrite: Type.Optional(Type.String({ description: "Replacement string (run mode only)" })),
	language: Type.Optional(Type.String({ description: "Language, e.g. ts, js, python, rust" })),
	path: Type.Optional(Type.String({ description: "Path to search (default: cwd)" })),
	rule: Type.Optional(Type.String({ description: "Path to a rule YAML file (scan mode)" })),
	config: Type.Optional(Type.String({ description: "Path to ast-grep config (sgconfig.yml)" })),
	updateAll: Type.Optional(
		Type.Boolean({
			description:
				"If true AND rewrite/rule provides a fix, apply changes without confirmation. Otherwise only report proposed replacements.",
		}),
	),
});

function formatAstGrepResult(matches: any[]): string {
	if (!Array.isArray(matches) || matches.length === 0) {
		return "No matches found.";
	}

	const lines: string[] = [];
	for (const m of matches.slice(0, 100)) {
		const file = m.file ?? "<?>";
		const range = m.range?.start;
		const location = range ? `${file}:${range.line}:${range.column}` : file;
		const textPreview =
			typeof m.text === "string" ? m.text.replace(/\s+/g, " ").slice(0, 120) : "";
		lines.push(`- ${location}: ${textPreview}`);
		if (typeof m.replacement === "string") {
			lines.push(`  → ${m.replacement.replace(/\s+/g, " ").slice(0, 120)}`);
		}
	}
	if (matches.length > 100) {
		lines.push(`\n... and ${matches.length - 100} more matches.`);
	}
	return lines.join("\n");
}

function registerAstGrep(pi: ExtensionAPI) {
	pi.registerTool({
		name: "ast_grep",
		label: "ast-grep",
		description:
			"AST-based code search and rewrite using ast-grep. Prefer this for structure-aware patterns (functions, imports, class members) instead of text grep.",
		parameters: AstGrepParams,
		promptGuidelines: [
			"Use `ast_grep` when searching for code structures (e.g. 'all function calls to X', 'imports from Y'), not raw text.",
			"For simple text search, prefer `rg`.",
			"With rewrite, keep `updateAll` false first and review the proposed replacements, then call again with `updateAll: true` if they look correct.",
		],
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			const mode = params.mode || "run";
			const searchPath = resolvePath(ctx, params.path || ".");
			let args: string[] = [mode, "--color=never", "--json=compact"];

			if (mode === "run") {
				if (!params.pattern) {
					throw new Error("ast_grep run mode requires a `pattern` parameter.");
				}
				args.push("-p", params.pattern);
				if (params.rewrite) args.push("-r", params.rewrite);
				if (params.language) args.push("-l", params.language);
			} else if (mode === "scan") {
				if (params.rule) args.push("-r", params.rule);
				if (params.config) args.push("-c", params.config);
			}

			if (params.updateAll) {
				args.push("--update-all");
			}

			args.push(searchPath);

			let result: RunResult;
			try {
				result = await runCommand(["ast-grep", "sg"], args, ctx.cwd, signal);
			} catch (err: any) {
				if (err.code === 1 && !err.stderr) {
					return {
						content: [{ type: "text", text: "No matches found" }],
						details: { mode, pattern: params.pattern, matchCount: 0 },
					};
				}
				throw new Error(`ast-grep failed: ${err.message}`);
			}

			if (!result.stdout.trim()) {
				return {
					content: [{ type: "text", text: "No matches found" }],
					details: { mode, pattern: params.pattern, matchCount: 0 },
				};
			}

			let matches: any[];
			try {
				matches = JSON.parse(result.stdout);
			} catch {
				// Fallback to raw output if JSON cannot be parsed.
				return {
					content: [{ type: "text", text: result.stdout }],
					details: { mode, pattern: params.pattern, parsed: false },
				};
			}

			const formatted = formatAstGrepResult(matches);
			const { text, fullOutputPath } = await maybeTruncate(formatted, "pi-ast-grep-");

			return {
				content: [{ type: "text", text }],
				details: {
					mode,
					pattern: params.pattern,
					matchCount: matches.length,
					fullOutputPath,
				},
			};
		},
	});
}

// ---------------------------------------------------------------------------
// format_file — run Prettier or Biome
// ---------------------------------------------------------------------------

const FormatParams = Type.Object({
	path: Type.String({ description: "File or directory to format" }),
	formatter: Type.Optional(
		Type.Union([Type.Literal("auto"), Type.Literal("prettier"), Type.Literal("biome")], {
			description: "Formatter to use (default: auto-detect)",
		}),
	),
});

async function detectFormatter(cwd: string): Promise<"prettier" | "biome"> {
	const check = async (rel: string) => {
		try {
			await access(resolve(cwd, rel));
			return true;
		} catch {
			return false;
		}
	};

	const hasPrettierConfig =
		(await check(".prettierrc")) ||
		(await check(".prettierrc.json")) ||
		(await check(".prettierrc.js")) ||
		(await check(".prettierrc.mjs")) ||
		(await check("prettier.config.js")) ||
		(await check("prettier.config.mjs"));

	const hasBiomeConfig = await check("biome.json");

	if (hasBiomeConfig) return "biome";
	if (hasPrettierConfig) return "prettier";

	// Look at package.json for devDependencies clues.
	try {
		const pkgText = await readFile(resolve(cwd, "package.json"), "utf8");
		const pkg = JSON.parse(pkgText);
		const deps = {
			...pkg.dependencies,
			...pkg.devDependencies,
			...pkg.peerDependencies,
		};
		if (deps["@biomejs/biome"]) return "biome";
		if (deps.prettier) return "prettier";
	} catch {
		// ignore
	}

	// Default to prettier as the most common formatter.
	return "prettier";
}

function registerFormatFile(pi: ExtensionAPI) {
	pi.registerTool({
		name: "format_file",
		label: "Format File",
		description:
			"Format a file or directory using Prettier or Biome. Auto-detects which formatter the project uses. Run this after editing code when the project has a formatter configured.",
		parameters: FormatParams,
		promptGuidelines: [
			"Run `format_file` on any file you edit when the project uses Prettier or Biome.",
			"Do not manually re-format code with `bash` when this tool is available.",
		],
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			const target = resolvePath(ctx, params.path);
			const formatter = params.formatter === "auto" || !params.formatter
				? await detectFormatter(ctx.cwd)
				: params.formatter;

			let command: string;
			let args: string[];

			if (formatter === "biome") {
				command = "npx";
				args = ["@biomejs/biome", "check", "--write", target];
			} else {
				command = "npx";
				args = ["prettier", "--write", target];
			}

			let result: RunResult;
			try {
				result = await runCommand([command], args, ctx.cwd, signal);
			} catch (err: any) {
				throw new Error(
					`${formatter} failed: ${err.message}\n\nMake sure the formatter is installed in the project or install it (${formatter === "biome" ? "npm i -D @biomejs/biome" : "npm i -D prettier"}).`,
				);
			}

			const output = result.stdout + (result.stderr ? `\n${result.stderr}` : "");
			return {
				content: [{ type: "text", text: output.trim() || `${formatter} completed.` }],
				details: { formatter, target },
			};
		},
	});
}

// ---------------------------------------------------------------------------
// git_status — concise repo state before finishing
// ---------------------------------------------------------------------------

const GitStatusParams = Type.Object({});

function registerGitStatus(pi: ExtensionAPI) {
	pi.registerTool({
		name: "git_status",
		label: "Git Status",
		description:
			"Show concise git status: current branch, changed files, and diff stat. Use before finishing a coding task to see what changed. Do not commit without user confirmation.",
		parameters: GitStatusParams,
		promptGuidelines: [
			"Run `git_status` before finishing a task to review changes.",
			"Never commit, push, or run destructive git commands without explicit user approval.",
		],
		async execute(_toolCallId, _params, signal, _onUpdate, ctx) {
			let status: string;
			try {
				const { stdout } = await runCommand(["git"], ["status", "--short", "--branch"], ctx.cwd, signal);
				status = stdout.trim();
			} catch (err: any) {
				throw new Error(`git status failed: ${err.message}`);
			}

			let diffStat = "";
			try {
				const { stdout } = await runCommand(["git"], ["diff", "--stat"], ctx.cwd, signal);
				diffStat = stdout.trim();
			} catch {
				// ignore; repo may have no commits yet
			}

			const text = [status || "No changes.", diffStat ? `\nDiff stat:\n${diffStat}` : ""]
				join("\n")
				.trim();

			return {
				content: [{ type: "text", text }],
				details: { hasChanges: status.length > 0 },
			};
		},
	});
}

// ---------------------------------------------------------------------------
// trash — move files/folders to /tmp instead of deleting them
// ---------------------------------------------------------------------------

const TrashParams = Type.Object({
	path: Type.String({ description: "File or directory to move to the trash" }),
});

function computeTrashDestination(source: string): { trashDir: string; destination: string } {
	// Preserve the original absolute path under a unique /tmp trash folder.
	// e.g. /workspaces/foo/bar -> /tmp/pi-trash-XXXXXX/workspaces/foo/bar
	const trashDir = mkdtempSync(join(tmpdir(), "pi-trash-"));
	const absoluteSource = resolve(source);
	const relative = absoluteSource.replace(/^\//, "");
	const destination = join(trashDir, relative);
	return { trashDir, destination };
}

function registerTrash(pi: ExtensionAPI) {
	pi.registerTool({
		name: "trash",
		label: "Trash",
		description:
			"Move a file or directory to a temporary /tmp location instead of deleting it. This preserves the original folder structure so it can be recovered if needed.",
		parameters: TrashParams,
		promptGuidelines: [
			"Use `trash` whenever you would otherwise delete a file or folder (e.g. instead of `rm` or `rmdir`).",
			"Do not use `rm`, `rm -rf`, `rmdir`, or `unlink` through the `bash` tool.",
		],
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			const source = resolvePath(ctx, params.path);
			const { trashDir, destination } = computeTrashDestination(source);

			// Ensure destination parent directory exists, then move.
			try {
				await runCommand(["mkdir"], ["-p", join(destination, "..")], ctx.cwd, signal);
				await runCommand(["mv"], [source, destination], ctx.cwd, signal);
			} catch (err: any) {
				throw new Error(`Trash failed for "${params.path}": ${err.message}`);
			}

			return {
				content: [
					{
						type: "text",
						text: `Moved "${source}" to trash:\n${destination}\n\nTrash root:\n${trashDir}`,
					},
				],
				details: { source, destination, trashDir },
			};
		},
	});
}


// ---------------------------------------------------------------------------

function buildGuidance(_options: BuildSystemPromptOptions, basePrompt: string): string {
	return `${basePrompt}

## Standard Tool Rules

- Prefer the custom tools exposed by the Standard Tools extension:
  - Use \`rg\` instead of the built-in \`grep\` tool.
  - Use \`fd\` instead of the built-in \`find\` tool or \`ls -R\`.
  - Use \`ast_grep\` for structure-aware code search and refactoring.
  - Use \`format_file\` after editing code when the project uses Prettier or Biome.
  - Use \`git_status\` to review changes before finishing a task.
- Do **not** use \`apply_patch\` or equivalent patch commands. Prefer \`quick_edit\` (line-number edits) and \`target_edit\` (marker edits). Fall back to built-in \`edit\`/\`write\` only when those are not available.
- Do **not** delete files or folders with \`rm\`, \`rm -rf\`, \`rmdir\`, or \`unlink\`. Move them to \`/tmp\` using the \`trash\` tool instead.
- Never run \`git commit\`, \`git push\`, or other destructive shell commands without explicit user confirmation.
- Avoid using \`grep\` or \`find\` through \`bash\`; use the dedicated tools instead.
`;
}

function registerPromptInjector(pi: ExtensionAPI) {
	pi.on("before_agent_start", async (event) => {
		const { systemPrompt, systemPromptOptions } = event;
		return {
			systemPrompt: buildGuidance(systemPromptOptions, systemPrompt),
		};
	});
}

// ---------------------------------------------------------------------------
// Runtime guardrails
// ---------------------------------------------------------------------------


const SUSPICIOUS_PATTERNS = [
	{ regex: /(?:^|[;|&]|\$\(\s*)\s*\bgrep\b(?!\s+-\w*\s+ripgrep|\s+ripgrep)/i, preferred: "rg" },
	{ regex: /(?:^|[;|&]|\$\(\s*)\s*\bfind\s+\./i, preferred: "fd" },
	{ regex: /\bapply_patch\b|\bpatch\s+-p/i, preferred: "quick_edit, target_edit, or edit" },
];

// Matches commands that destroy files/folders. We block these before they run.
const DELETION_COMMANDS = ["rm", "rmdir", "unlink", "shred"];
const DELETION_REGEX = new RegExp(
	`(?:^|[;|&]|\\$\\(\\s*)\\s*\\b(${DELETION_COMMANDS.join("|")})\\b`,
	"i",
);

function registerGuardrails(pi: ExtensionAPI) {
	pi.on("tool_call", async (event, ctx) => {
		if (!isToolCallEventType("bash", event)) return;
		const command = event.input?.command;
		if (typeof command !== "string") return;

		// Block file/folder deletion.
		if (DELETION_REGEX.test(command)) {
			return {
				block: true,
				reason: `Deleting files/folders is not allowed. Use the \`trash\` tool, or move the item to /tmp manually (e.g. \`mv <path> /tmp/pi-trash-$(date +%s)/<original-path>\`).`,
			};
		}

		// Warn about other non-standard patterns without blocking.
		for (const { regex, preferred } of SUSPICIOUS_PATTERNS) {
			if (regex.test(command)) {
				ctx.ui.notify(
					`⚠️ Detected non-standard tool usage in bash: "${command.slice(0, 60)}...". Prefer \`${preferred}\`.`,
					"warning",
				);
				break;
			}
		}
	});
}

// ---------------------------------------------------------------------------
// Fast edit tools (quick_edit / target_edit)
// ---------------------------------------------------------------------------

function registerFastEditTools(pi: ExtensionAPI) {
	pi.registerTool({
		name: "quick_edit",
		label: "quick-edit",
		description:
			"Edit a file by 1-indexed line number or inclusive line range. Requires expectedStartLine for each edit (except start=\"eof\") to guard against stale line content. Atomic: any invalid edit rejects the whole batch.",
		promptSnippet: "Edit files by line number with expectedStartLine guard",
		promptGuidelines: [
			'Use start/end as 1-indexed line numbers from the current file snapshot. Prefer start=\"eof\" to append at end of file.',
			'For an EOF append, send exactly { start: \"eof\", lines: [...] }.',
			'Always provide expectedStartLine with the current content of the start line (not required for start=\"eof\").',
			'Default guard matching is exact. When indentation is uncertain, set whitespace=\"indent_tolerant\".',
			"For multi-line ranges, prefer expectedEndLine and/or expectedLineCount guards.",
			"Omit end for a single-line replacement. Use lines: [] to delete a line or range. Use lines: [\"\"] for one blank line.",
			"Batch edits are snapshot-based, not sequential; do not renumber later edits after earlier insert/delete ops.",
			"Batch multiple independent ranges in one call; overlapping ranges are rejected atomically.",
		],
		parameters: QuickEditParams,

		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const absolutePath = resolve(ctx.cwd, params.path);
			const text = await withFileMutationQueue(absolutePath, () => applyQuickEdits(absolutePath, params.edits));
			return { content: [{ type: "text" as const, text }], details: undefined };
		},
	});

	pi.registerTool({
		name: "target_edit",
		label: "target-edit",
		description:
			"Edit by finding exact target text, then use replace/delete or insert_before/insert_after. Atomic: any invalid operation rejects the whole batch.",
		promptSnippet: "Edit by exact target text with line or range selectors",
		promptGuidelines: [
			"Use target_edit when you know an exact marker/text but line numbers are inconvenient.",
			"Use exact literal target text only; no regex. Use \\n for multi-line targets and replacements.",
			"Set matchMode=trim when indentation or trailing whitespace may differ.",
			"Use line for a single occurrence, range for every occurrence inside an inclusive line range, or neither if the target is unique.",
		],
		parameters: TargetEditParams,

		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const absolutePath = resolve(ctx.cwd, params.path);
			const text = await withFileMutationQueue(absolutePath, () => applyTargetEdits(absolutePath, params.ops));
			return { content: [{ type: "text" as const, text }], details: undefined };
		},
	});

	pi.on("session_start", () => {
		const activeTools = pi.getActiveTools();
		const preferred = preferFastEditTools(activeTools);
		if (JSON.stringify(preferred) !== JSON.stringify(activeTools)) {
			pi.setActiveTools(preferred);
		}
	});

	pi.on("tool_result", async (event: any, ctx: any) => {
		try {
			if (event.toolName !== "read" || event.isError) return;
			if (event.content.some((part: any) => part.type === "image")) return;
			if (!event.input || typeof event.input.path !== "string") return;
			const absolutePath = resolve(ctx.cwd, event.input.path);
			const fileContent = await readFile(absolutePath, "utf8");
			const lineCount = fileContent === "" ? 0 : fileContent.endsWith("\n") ? fileContent.slice(0, -1).split("\n").length : fileContent.split("\n").length;
			const startLine =
				typeof event.input.offset === "number" && Number.isFinite(event.input.offset)
					? Math.max(1, Math.floor(event.input.offset))
					: 1;
			return {
				content: event.content.map((part: any) =>
					part.type === "text" && part.text ? { ...part, text: numberReadText(part.text, { startLine, totalLineCount: lineCount }) } : part,
				),
			};
		} catch {
			// Ignore read-numbering failures.
		}
	});
}

// ---------------------------------------------------------------------------
// Entrypoint
// ---------------------------------------------------------------------------

export default async function standardToolsExtension(pi: ExtensionAPI) {
	registerFastEditTools(pi);

	registerRg(pi);
	registerFd(pi);
	registerAstGrep(pi);
	registerFormatFile(pi);
	registerGitStatus(pi);
	registerTrash(pi);
	registerPromptInjector(pi);
	registerGuardrails(pi);
}
