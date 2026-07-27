import { Type, type Static } from "@earendil-works/pi-ai";

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
