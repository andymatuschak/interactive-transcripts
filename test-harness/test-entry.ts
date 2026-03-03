/**
 * Test harness entry point.
 * Exports real extensions for browser testing.
 * Also re-exports CodeMirror to avoid multiple instance conflicts.
 */

export { transcriptEditingExtension } from "../src/editor/transcriptEditing";
export { copyHandlerExtension } from "../src/editor/copyHandler";
export { transcriptField } from "../src/editor/state";
export { alignmentStore } from "../src/alignment/alignmentStore";
export { parseTranscriptDirectives } from "../src/core/parser";
export { deleteFromTranscript } from "../src/core/operations";
export type { TranscriptDirective, AlignmentData, AlignedSegment, AlignedWord } from "../src/types";

// Re-export CodeMirror modules to use a single instance
export { EditorState } from "@codemirror/state";
export { EditorView, keymap } from "@codemirror/view";
export { defaultKeymap, insertNewlineAndIndent } from "@codemirror/commands";
