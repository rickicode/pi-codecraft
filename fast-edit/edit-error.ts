export type EditErrorCode =
	| "EXPECTED_START_LINE_MISMATCH"
	| "EXPECTED_END_LINE_MISMATCH"
	| "EXPECTED_LINE_COUNT_MISMATCH"
	| "RANGE_OUT_OF_BOUNDS"
	| "INVALID_RANGE"
	| "OVERLAPPING_RANGES"
	| "TARGET_NOT_FOUND"
	| "TARGET_AMBIGUOUS"
	| "VALIDATION"
	| "EMPTY_BATCH";

export type EditFailureCandidate = { line: number; text: string };

export type EditFailure = {
	error_code: EditErrorCode;
	message: string;
	edit_index?: number;
	op_index?: number;
	at_line?: number;
	end_line?: number;
	actual?: string;
	expected?: string;
	candidates?: EditFailureCandidate[];
	suggested?: Record<string, unknown>;
	details?: Record<string, unknown>;
};

export const FAST_EDIT_ERROR_MARKER = "--- fast-edit-error ---";

export class FastEditError extends Error {
	readonly failure: EditFailure;

	constructor(failure: EditFailure, diagnostics: Array<string | undefined> = []) {
		const body = [failure.message, ...diagnostics.filter((s): s is string => Boolean(s))].join("\n");
		super(`${body}\n${FAST_EDIT_ERROR_MARKER}\n${JSON.stringify(failure)}`);
		this.name = "FastEditError";
		this.failure = failure;
	}
}

export function fail(failure: EditFailure, diagnostics: Array<string | undefined> = []): never {
	throw new FastEditError(failure, diagnostics);
}

export function parseFastEditError(error: unknown): EditFailure | undefined {
	if (error instanceof FastEditError) return error.failure;
	if (!(error instanceof Error)) return undefined;
	const markerIndex = error.message.indexOf(FAST_EDIT_ERROR_MARKER);
	if (markerIndex === -1) return undefined;
	const json = error.message.slice(markerIndex + FAST_EDIT_ERROR_MARKER.length).trim();
	try {
		const parsed = JSON.parse(json) as EditFailure;
		if (parsed && typeof parsed.error_code === "string" && typeof parsed.message === "string") {
			return parsed;
		}
	} catch {
		// ignore parse errors
	}
	return undefined;
}
