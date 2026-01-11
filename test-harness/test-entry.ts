/**
 * Test harness entry point.
 * Exports real extensions for browser testing.
 */

export { transcriptEditingExtension } from "../src/editor/transcriptEditing";
export { transcriptField } from "../src/editor/state";
export { alignmentStore } from "../src/alignment/alignmentStore";
export { parseTranscriptDirectives } from "../src/core/parser";
export { deleteFromTranscript } from "../src/core/operations";
export type { TranscriptDirective, AlignmentData, AlignedSegment, AlignedWord } from "../src/types";
