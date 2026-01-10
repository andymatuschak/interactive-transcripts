import { EditorView } from "@codemirror/view";
import { transcriptField } from "./state";
import { alignmentStore } from "../alignment/alignmentStore";
import { serializeDirective, createExcerptDirective } from "../core/serializer";
import type { TranscriptDirective, AlignedWord } from "../types";

/**
 * Find timestamps for a text range within the transcript content.
 * Returns the start time of the first word and end time of the last word
 * that overlap with the selection.
 */
function findTimestampsForRange(
	directive: TranscriptDirective,
	selectionStartOffset: number,
	selectionEndOffset: number
): { startTime: number; endTime: number } | null {
	const words = alignmentStore.getWords(directive.audioPath, directive.content);
	if (words.length === 0) return null;

	const content = directive.content;
	let startTime: number | null = null;
	let endTime: number | null = null;
	let charPos = 0;

	for (const word of words) {
		const wordText = word.word.trim();
		const idx = content.indexOf(wordText, charPos);
		if (idx === -1) continue;

		const wordStart = idx;
		const wordEnd = idx + wordText.length;
		charPos = wordEnd;

		// Check if this word overlaps with the selection
		const overlaps = wordEnd > selectionStartOffset && wordStart < selectionEndOffset;

		if (overlaps) {
			if (startTime === null) {
				startTime = word.start;
			}
			endTime = word.end;
		}
	}

	if (startTime === null || endTime === null) return null;

	return { startTime, endTime };
}

/**
 * Handle copy events within transcript blocks.
 * When copying text from a transcript, creates a new directive with timestamps.
 */
function handleCopy(event: ClipboardEvent, view: EditorView): boolean {
	const selection = view.state.selection.main;
	if (selection.empty) return false;

	// Find if selection is within a transcript directive
	const fieldValue = view.state.field(transcriptField, false);
	if (!fieldValue) return false;

	// Find directive that contains the selection
	const directive = fieldValue.directives.find(
		(d) => selection.from >= d.contentFrom && selection.to <= d.to
	);
	if (!directive) return false;

	// Check if we have alignment data
	if (!alignmentStore.has(directive.audioPath, directive.content)) {
		// No alignment data - allow normal copy
		return false;
	}

	// Calculate offsets within the content
	const selectionStartOffset = selection.from - directive.contentFrom;
	const selectionEndOffset = selection.to - directive.contentFrom;

	// Ensure selection is within content bounds
	if (selectionStartOffset < 0 || selectionEndOffset > directive.content.length) {
		return false;
	}

	// Find timestamps for the selection
	const timestamps = findTimestampsForRange(directive, selectionStartOffset, selectionEndOffset);
	if (!timestamps) {
		// Couldn't find timestamps - allow normal copy
		return false;
	}

	// Get selected text
	const selectedText = view.state.sliceDoc(selection.from, selection.to);

	// Create excerpt directive with timestamps
	const excerpt = createExcerptDirective(
		directive,
		selectedText.trim(),
		timestamps.startTime,
		timestamps.endTime
	);

	// Set clipboard with serialized directive
	event.preventDefault();
	event.clipboardData?.setData("text/plain", serializeDirective(excerpt));

	return true;
}

/**
 * Extension that intercepts copy events to include timestamps.
 */
export const copyHandlerExtension = EditorView.domEventHandlers({
	copy: handleCopy,
});
