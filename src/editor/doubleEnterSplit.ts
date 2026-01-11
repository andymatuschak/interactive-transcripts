import { EditorState, Transaction } from "@codemirror/state";
import { transcriptField } from "./state";
import { alignmentStore } from "../alignment/alignmentStore";
import { splitTranscript, splitTranscriptAroundRange } from "../core/operations";
import type { TranscriptDirective } from "../types";

/**
 * Find a text replacement in a transaction that should trigger a split.
 * Returns the replacement info if found, or null.
 */
function findTextReplacement(
	tr: Transaction
): { from: number; to: number; inserted: string } | null {
	let result: { from: number; to: number; inserted: string } | null = null;

	tr.changes.iterChanges((fromA, toA, _fromB, _toB, inserted) => {
		// Must be a replacement (deleting some text)
		if (fromA === toA) return;

		const insertedText = inserted.toString();

		// Check if both old and new contain non-whitespace
		const deletedText = tr.startState.doc.sliceString(fromA, toA);
		const hasNonWhitespaceDeleted = /\S/.test(deletedText);
		const hasNonWhitespaceInserted = /\S/.test(insertedText);

		// Only handle if replacing non-whitespace with non-whitespace
		if (hasNonWhitespaceDeleted && hasNonWhitespaceInserted) {
			result = { from: fromA, to: toA, inserted: insertedText };
		}
	});

	return result;
}

/**
 * Check if text replacement should trigger a split.
 * Replacing non-whitespace text with non-whitespace text inside a transcript
 * splits around the replaced range, with the replacement on the line between.
 */
function handleTextReplacement(tr: Transaction): Transaction | null {
	const replaceInfo = findTextReplacement(tr);
	if (!replaceInfo) return null;

	const { from, to, inserted } = replaceInfo;

	// Check if the replacement is inside a transcript block
	const { directives } = tr.startState.field(transcriptField);
	const directive = directives.find(
		(d: TranscriptDirective) => from >= d.contentFrom && to <= d.to - 3
	);

	if (!directive) return null;

	// Look up alignment
	const alignment = alignmentStore.get(directive.audioPath, directive.content);
	if (!alignment) return null;

	// Calculate offsets within the content
	const startOffset = from - directive.contentFrom;
	const endOffset = to - directive.contentFrom;

	// Validate offsets
	if (startOffset < 0 || endOffset > directive.content.length) return null;

	// Perform the range split
	const { beforeMarkdown, afterMarkdown, beforeAlignment, afterAlignment } =
		splitTranscriptAroundRange(directive, alignment, startOffset, endOffset);

	// Store split alignments
	if (beforeAlignment) {
		alignmentStore.set(directive.audioPath, beforeAlignment.text, beforeAlignment);
	}
	if (afterAlignment) {
		alignmentStore.set(directive.audioPath, afterAlignment.text, afterAlignment);
	}

	// Build replacement: before directive, replacement text, after directive
	const parts: string[] = [];
	if (beforeMarkdown !== "") parts.push(beforeMarkdown);
	parts.push(inserted);
	if (afterMarkdown !== "") parts.push(afterMarkdown);
	const replacement = parts.join("\n\n");

	// Cursor goes after the inserted text
	const cursorPos = directive.from + (beforeMarkdown !== "" ? beforeMarkdown.length + 2 : 0) + inserted.length;

	return tr.startState.update({
		changes: {
			from: directive.from,
			to: directive.to,
			insert: replacement,
		},
		selection: { anchor: cursorPos },
		annotations: Transaction.userEvent.of("input"),
	});
}

/**
 * Transaction filter that intercepts edits in transcript blocks.
 * - Newline at start of line: splits transcript at that position
 * - Text replacement (typing or paste): splits around the replaced range
 */
function transcriptSplitFilter(tr: Transaction): Transaction | readonly Transaction[] {
	// Only handle document changes
	if (!tr.docChanged) {
		return tr;
	}

	// Check for text replacement that should trigger split (handles both typing and paste)
	if (tr.isUserEvent("input")) {
		const replacementResult = handleTextReplacement(tr);
		if (replacementResult) {
			return replacementResult;
		}
	}

	// Double-enter split only for keyboard input (not paste)
	if (!tr.isUserEvent("input.type")) {
		return tr;
	}

	// Check if this transaction inserts a newline
	let newlineInsertPos: number | null = null;
	tr.changes.iterChanges((fromA, _toA, _fromB, _toB, inserted) => {
		const text = inserted.toString();
		if (text === "\n" || text === "\r\n") {
			newlineInsertPos = fromA;
		}
	});

	if (newlineInsertPos === null) {
		return tr;
	}

	const insertPos = newlineInsertPos; // Narrowed to number

	// Only split if inserting newline at the start of a line (i.e., after another newline)
	// This mimics bullet list behavior: Enter once inserts newline, Enter again on empty line triggers action
	const doc = tr.startState.doc;
	const charBefore = insertPos > 0 ? doc.sliceString(insertPos - 1, insertPos) : "";
	if (charBefore !== "\n") {
		return tr; // Not at start of line, allow normal newline
	}

	// Check if the insertion is inside a transcript block
	const { directives } = tr.startState.field(transcriptField);
	const directive = directives.find(
		(d: TranscriptDirective) =>
			insertPos > d.contentFrom && insertPos < d.to - 3
	);

	if (!directive) {
		return tr;
	}

	// The directive.content includes the newline from the first Enter.
	// Calculate the expected newline position in the content.
	const docNewlinePos = insertPos - 1;
	const expectedOffset = docNewlinePos - directive.contentFrom;

	// Find the actual newline - may be off by 1 due to editor whitespace handling
	const searchOffsets = [expectedOffset, expectedOffset - 1, expectedOffset + 1];
	const newlineOffsetInContent = searchOffsets.find(
		offset => offset >= 0 && offset < directive.content.length && directive.content[offset] === "\n"
	);

	if (newlineOffsetInContent === undefined) {
		return tr;
	}

	// Look up alignment - the store normalizes whitespace, so the newline will match
	const alignment = alignmentStore.get(directive.audioPath, directive.content);
	if (!alignment) {
		return tr;
	}

	// Split offset is where the newline was
	const splitOffset = newlineOffsetInContent;
	if (splitOffset <= 0 || splitOffset >= directive.content.length - 1) {
		return tr;
	}

	// Create a directive without the newline for splitting
	const contentForSplit =
		directive.content.slice(0, newlineOffsetInContent) +
		directive.content.slice(newlineOffsetInContent + 1);

	const directiveForSplit = {
		...directive,
		content: contentForSplit,
	};

	// Perform the split
	const { beforeMarkdown, afterMarkdown, beforeAlignment, afterAlignment } = splitTranscript(
		directiveForSplit,
		alignment,
		splitOffset
	);

	// Store split alignments so they don't need to be regenerated
	if (beforeAlignment.text) {
		alignmentStore.set(directive.audioPath, beforeAlignment.text, beforeAlignment);
	}
	if (afterAlignment.text) {
		alignmentStore.set(directive.audioPath, afterAlignment.text, afterAlignment);
	}

	const replacement = `${beforeMarkdown}\n\n${afterMarkdown}`;

	// Calculate cursor position: the blank line between the two directives
	const cursorPos = directive.from + beforeMarkdown.length + 1;

	// Create a new transaction that replaces the directive instead of inserting a newline
	return tr.startState.update({
		changes: {
			from: directive.from,
			to: directive.to,
			insert: replacement,
		},
		selection: { anchor: cursorPos },
		// Preserve user event annotation
		annotations: Transaction.userEvent.of("input"),
	});
}

/**
 * CodeMirror extension for automatic transcript splitting.
 * Handles two cases:
 * 1. Double-Enter: When Enter is pressed at the start of a line inside an aligned
 *    transcript, the transcript is split at that position with appropriate timestamps.
 * 2. Text replacement: When non-whitespace text is replaced with non-whitespace text
 *    inside an aligned transcript, the transcript splits around the replaced range
 *    with the replacement text on the line between the two resulting blocks.
 */
export const doubleEnterSplitExtension = EditorState.transactionFilter.of(
	transcriptSplitFilter
);
