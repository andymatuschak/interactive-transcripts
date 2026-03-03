import { ViewPlugin, ViewUpdate, EditorView } from "@codemirror/view";
import { transcriptField } from "./state";
import { alignmentStore } from "../alignment/alignmentStore";
import { serializeDirective, createExcerptDirective } from "../core/serializer";
import type { TranscriptDirective, AlignedWord } from "../types";

/** Prefix used to identify transcript directives on the clipboard. */
const DIRECTIVE_PREFIX = ":::transcript[";

/**
 * Find timestamps for a text range within the transcript content.
 * Returns the start time of the first word and end time of the last word
 * that overlap with the selection.
 */
function findTimestampsForRange(
	directive: TranscriptDirective,
	rawContent: string,
	selectionStartOffset: number,
	selectionEndOffset: number
): { startTime: number; endTime: number } | null {
	const words = alignmentStore.getWords(directive.audioPath, directive.content);
	if (words.length === 0) return null;

	const content = rawContent;
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
function handleCopy(event: ClipboardEvent, view: EditorView): void {
	const selection = view.state.selection.main;
	if (selection.empty) return;

	// Find if selection is within a transcript directive
	const fieldValue = view.state.field(transcriptField, false);
	if (!fieldValue) return;

	// Find directive that contains the selection
	const directive = fieldValue.directives.find(
		(d) => selection.from >= d.contentFrom && selection.to <= d.to
	);
	if (!directive) return;

	// Check if we have alignment data
	if (!alignmentStore.has(directive.audioPath, directive.content)) {
		return;
	}

	// Use raw document text for position calculations
	const rawContent = view.state.doc.sliceString(directive.contentFrom, directive.to - 3);

	// Calculate offsets within the content
	const selectionStartOffset = selection.from - directive.contentFrom;
	const selectionEndOffset = selection.to - directive.contentFrom;

	// Ensure selection is within content bounds
	if (selectionStartOffset < 0 || selectionEndOffset > rawContent.length) {
		return;
	}

	// Find timestamps for the selection
	const timestamps = findTimestampsForRange(directive, rawContent, selectionStartOffset, selectionEndOffset);
	if (!timestamps) return;

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
	const serialized = serializeDirective(excerpt);
	event.preventDefault();
	event.clipboardData?.setData("text/plain", serialized);
}

/**
 * Handle paste events to bypass Obsidian's smart paste for transcript directives.
 * Obsidian's Cmd+V processes clipboard content as markdown, stripping :::
 * container directive syntax. This handler detects transcript directives on the
 * clipboard and inserts them as raw text.
 */
function handlePaste(event: ClipboardEvent, view: EditorView): void {
	const text = event.clipboardData?.getData("text/plain");
	if (!text || !text.startsWith(DIRECTIVE_PREFIX)) return;

	event.preventDefault();

	const { from, to } = view.state.selection.main;
	view.dispatch({
		changes: { from, to, insert: text },
		selection: { anchor: from + text.length },
		userEvent: "input.paste",
	});
}

/**
 * ViewPlugin that attaches copy and paste event listeners directly to the editor DOM.
 * Uses direct DOM listeners instead of CM6's domEventHandlers to ensure
 * the handlers fire reliably in all host environments (including Obsidian).
 */
const clipboardViewPlugin = ViewPlugin.fromClass(
	class {
		private copyHandler: (e: ClipboardEvent) => void;
		private pasteHandler: (e: ClipboardEvent) => void;

		constructor(private view: EditorView) {
			this.copyHandler = (e: ClipboardEvent) => handleCopy(e, this.view);
			this.pasteHandler = (e: ClipboardEvent) => handlePaste(e, this.view);
			this.view.contentDOM.addEventListener("copy", this.copyHandler);
			// Use capture phase so we run before Obsidian's paste handler
			this.view.contentDOM.addEventListener("paste", this.pasteHandler, true);
		}

		update(_update: ViewUpdate) {}

		destroy() {
			this.view.contentDOM.removeEventListener("copy", this.copyHandler);
			this.view.contentDOM.removeEventListener("paste", this.pasteHandler, true);
		}
	}
);

/**
 * Extension that intercepts copy/paste events for transcript directives.
 */
export const copyHandlerExtension = clipboardViewPlugin;
