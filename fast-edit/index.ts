export {
	QuickEditParams,
	TargetEditParams,
	type QuickEditInput,
	type Edit,
	type TargetEditInput,
	type TargetEditOp,
} from "./schemas.js";

export {
	FAST_EDIT_ERROR_MARKER,
	FastEditError,
	fail,
	parseFastEditError,
	type EditErrorCode,
	type EditFailure,
	type EditFailureCandidate,
} from "./edit-error.js";

export {
	splitBom,
	joinBom,
	splitLines,
	detectLineEnding,
	unescapeLiteral,
	leadingIndent,
	withPreservedIndent,
	splitLinesWithOffsets,
	lineStartOffsets,
	lineIndexAt,
	lineOf,
	trimLeadingLength,
	trimTrailingLength,
	trimmedTargetLines,
	type TextLine,
} from "./text.js";

export {
	CONTEXT_LINES,
	formatDiffs,
	formatContexts,
	type EditDiff,
	type ContextRange,
} from "./diff.js";

export {
	lineMatches,
	matchingLineNumbers,
	formatCandidates,
	findRawOccurrences,
	findTrimmedOccurrences,
	resolveOccurrenceLines,
	allOccurrences,
	selectOccurrences,
	hasRealContent,
	type Occurrence,
} from "./match-helpers.js";

export { applyQuickEdits } from "./quick-edit.js";
export { applyTargetEdits } from "./target-edit.js";
export { numberReadText } from "./read-hook.js";
export { preferFastEditTools } from "./active-tools.js";
