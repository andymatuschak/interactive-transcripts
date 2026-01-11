import { EditorState, Transaction } from "@codemirror/state";
import { transcriptField } from "./state";
import { alignmentStore } from "../alignment/alignmentStore";
import { splitTranscript, splitTranscriptAroundRange, deleteFromTranscript } from "../core/operations";
import type { AlignmentData, TranscriptDirective } from "../types";

/**
 * Context for editing within a transcript block.
 */
interface TranscriptEditContext {
	directive: TranscriptDirective;
	alignment: AlignmentData;
	startOffset: number;
	endOffset: number;
}

/**
 * Find directive and alignment for an edit range within a transcript block.
 * Returns null if the range is not inside a transcript or has no alignment.
 */
function findEditContext(
	tr: Transaction,
	from: number,
	to: number
): TranscriptEditContext | null {
	const { directives } = tr.startState.field(transcriptField);
	const directive = directives.find(
		(d: TranscriptDirective) => from >= d.contentFrom && to <= d.to - 3
	);

	if (!directive) return null;

	const alignment = alignmentStore.get(directive.audioPath, directive.content);
	if (!alignment) return null;

	const startOffset = from - directive.contentFrom;
	const endOffset = to - directive.contentFrom;

	// Validate offsets
	if (startOffset < 0 || endOffset > directive.content.length) return null;

	return { directive, alignment, startOffset, endOffset };
}

/**
 * Find a deletion in a transaction (deleting text without inserting non-whitespace).
 * Returns the deletion info if found, or null.
 */
export function findDeletion(
	tr: Transaction
): { from: number; to: number } | null {
	let result: { from: number; to: number } | null = null;

	tr.changes.iterChanges((fromA, toA, _fromB, _toB, inserted) => {
		if (fromA === toA) return;

		const insertedText = inserted.toString();
		const deletedText = tr.startState.doc.sliceString(fromA, toA);

		// Deletion: removing non-whitespace without inserting non-whitespace
		if (/\S/.test(deletedText) && !/\S/.test(insertedText)) {
			result = { from: fromA, to: toA };
		}
	});

	return result;
}

/**
 * Handle deletion inside a transcript block.
 * Adjusts timestamps and transforms alignment without regeneration.
 */
function handleDeletion(tr: Transaction): Transaction | null {
	const deleteInfo = findDeletion(tr);
	if (!deleteInfo) return null;

	const ctx = findEditContext(tr, deleteInfo.from, deleteInfo.to);
	if (!ctx) return null;

	const { directive, alignment, startOffset, endOffset } = ctx;

	const result = deleteFromTranscript(directive, alignment, startOffset, endOffset);
	if (!result) return null; // Would delete everything

	alignmentStore.set(directive.audioPath, result.alignment.text, result.alignment);

	const cursorOffset = Math.min(startOffset, result.alignment.text.length);
	const cursorPos = directive.from + result.markdown.indexOf("\n") + 1 + cursorOffset;

	return tr.startState.update({
		changes: {
			from: directive.from,
			to: directive.to,
			insert: result.markdown,
		},
		selection: { anchor: cursorPos },
		annotations: Transaction.userEvent.of("input"),
	});
}

/**
 * Find a text replacement in a transaction that should trigger a split.
 * Returns the replacement info if found, or null.
 */
export function findTextReplacement(
	tr: Transaction
): { from: number; to: number; inserted: string } | null {
	let result: { from: number; to: number; inserted: string } | null = null;

	tr.changes.iterChanges((fromA, toA, _fromB, _toB, inserted) => {
		if (fromA === toA) return;

		const insertedText = inserted.toString();
		const deletedText = tr.startState.doc.sliceString(fromA, toA);

		// Replacement: both deleted and inserted contain non-whitespace
		if (/\S/.test(deletedText) && /\S/.test(insertedText)) {
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

	const ctx = findEditContext(tr, replaceInfo.from, replaceInfo.to);
	if (!ctx) return null;

	const { directive, alignment, startOffset, endOffset } = ctx;
	const { inserted } = replaceInfo;

	const { beforeMarkdown, afterMarkdown, beforeAlignment, afterAlignment } =
		splitTranscriptAroundRange(directive, alignment, startOffset, endOffset);

	if (beforeAlignment) {
		alignmentStore.set(directive.audioPath, beforeAlignment.text, beforeAlignment);
	}
	if (afterAlignment) {
		alignmentStore.set(directive.audioPath, afterAlignment.text, afterAlignment);
	}

	// Build replacement: before directive, replacement text, after directive
	const parts: string[] = [];
	if (beforeMarkdown) parts.push(beforeMarkdown);
	parts.push(inserted);
	if (afterMarkdown) parts.push(afterMarkdown);
	const replacement = parts.join("\n\n");

	// Cursor goes after the inserted text
	const cursorPos = directive.from + (beforeMarkdown ? beforeMarkdown.length + 2 : 0) + inserted.length;

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
 * - Deletion: adjusts timestamps and transforms alignment
 */
function transcriptSplitFilter(tr: Transaction): Transaction | readonly Transaction[] {
	if (!tr.docChanged) {
		return tr;
	}

	// Handle text replacement (typing or paste over selection)
	if (tr.isUserEvent("input")) {
		const replacementResult = handleTextReplacement(tr);
		if (replacementResult) return replacementResult;
	}

	// Handle deletion (via input, backspace, or delete key)
	if (tr.isUserEvent("input") || tr.isUserEvent("delete")) {
		const deletionResult = handleDeletion(tr);
		if (deletionResult) return deletionResult;
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

	// Only split if inserting newline at the start of a line (after another newline)
	// This mimics bullet list behavior: Enter once inserts newline, Enter again triggers action
	const doc = tr.startState.doc;
	const charBefore = newlineInsertPos > 0 ? doc.sliceString(newlineInsertPos - 1, newlineInsertPos) : "";
	if (charBefore !== "\n") {
		return tr;
	}

	// Check if the insertion is inside a transcript block
	const { directives } = tr.startState.field(transcriptField);
	const directive = directives.find(
		(d: TranscriptDirective) =>
			newlineInsertPos! > d.contentFrom && newlineInsertPos! < d.to - 3
	);

	if (!directive) {
		return tr;
	}

	// The directive.content includes the newline from the first Enter.
	// Calculate the expected newline position in the content.
	const expectedOffset = (newlineInsertPos - 1) - directive.contentFrom;

	// Find the actual newline - may be off by 1 due to editor whitespace handling
	const searchOffsets = [expectedOffset, expectedOffset - 1, expectedOffset + 1];
	const splitOffset = searchOffsets.find(
		offset => offset >= 0 && offset < directive.content.length && directive.content[offset] === "\n"
	);

	if (splitOffset === undefined || splitOffset <= 0 || splitOffset >= directive.content.length - 1) {
		return tr;
	}

	const alignment = alignmentStore.get(directive.audioPath, directive.content);
	if (!alignment) {
		return tr;
	}

	// Create a directive without the newline for splitting
	const directiveForSplit = {
		...directive,
		content: directive.content.slice(0, splitOffset) + directive.content.slice(splitOffset + 1),
	};

	const { beforeMarkdown, afterMarkdown, beforeAlignment, afterAlignment } = splitTranscript(
		directiveForSplit,
		alignment,
		splitOffset
	);

	if (beforeAlignment.text) {
		alignmentStore.set(directive.audioPath, beforeAlignment.text, beforeAlignment);
	}
	if (afterAlignment.text) {
		alignmentStore.set(directive.audioPath, afterAlignment.text, afterAlignment);
	}

	const replacement = `${beforeMarkdown}\n\n${afterMarkdown}`;
	const cursorPos = directive.from + beforeMarkdown.length + 1;

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
 * CodeMirror extension for automatic transcript editing.
 * Handles three cases:
 * 1. Double-Enter: When Enter is pressed at the start of a line inside an aligned
 *    transcript, the transcript is split at that position with appropriate timestamps.
 * 2. Text replacement: When non-whitespace text is replaced with non-whitespace text
 *    inside an aligned transcript, the transcript splits around the replaced range
 *    with the replacement text on the line between the two resulting blocks.
 * 3. Deletion: When text is deleted inside an aligned transcript, timestamps are
 *    adjusted and alignment is transformed (not regenerated).
 */
export const transcriptEditingExtension = EditorState.transactionFilter.of(
	transcriptSplitFilter
);
