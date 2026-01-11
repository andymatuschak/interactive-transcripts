/**
 * Test harness entry point.
 * Exports real extensions for browser testing.
 */

export { doubleEnterSplitExtension } from "../src/editor/doubleEnterSplit";
export { transcriptField } from "../src/editor/state";
export { alignmentStore } from "../src/alignment/alignmentStore";
export { parseTranscriptDirectives } from "../src/core/parser";
export type { TranscriptDirective, AlignmentData, AlignedSegment, AlignedWord } from "../src/types";
