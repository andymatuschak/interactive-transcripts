import type { TranscriptDirective } from "../types";

/** Keep a renderer's source identity when a source-less view finds the next block. */
export function preserveDirectiveSource(
	current: TranscriptDirective,
	next: TranscriptDirective
): TranscriptDirective {
	return current.sourcePath && !next.sourcePath
		? { ...next, sourcePath: current.sourcePath }
		: next;
}
