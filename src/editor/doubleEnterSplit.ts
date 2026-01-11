import { EditorState, Transaction } from "@codemirror/state";
import { transcriptField } from "./state";
import { alignmentStore } from "../alignment/alignmentStore";
import { splitTranscript } from "../core/operations";
import type { TranscriptDirective } from "../types";

/**
 * Transaction filter that intercepts newline insertions in transcript blocks.
 * When Enter is pressed inside an aligned transcript, it splits the transcript
 * at that position instead of just inserting a newline.
 */
function transcriptSplitFilter(tr: Transaction): Transaction | readonly Transaction[] {
	// Only handle user input events that change the document
	if (!tr.isUserEvent("input") || !tr.docChanged) {
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
	const docNewlinePos = insertPos - 1; // Document position of the newline
	const expectedOffset = docNewlinePos - directive.contentFrom;

	// Find the actual newline - may be off by 1 due to editor whitespace handling
	let newlineOffsetInContent = -1;
	for (const offset of [expectedOffset, expectedOffset - 1, expectedOffset + 1]) {
		if (
			offset >= 0 &&
			offset < directive.content.length &&
			directive.content[offset] === "\n"
		) {
			newlineOffsetInContent = offset;
			break;
		}
	}

	if (newlineOffsetInContent < 0) {
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
	const { beforeMarkdown, afterMarkdown } = splitTranscript(
		directiveForSplit,
		alignment,
		splitOffset
	);

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
 * CodeMirror extension for automatic transcript splitting on Enter.
 * When Enter is pressed inside a transcript block with alignment,
 * the transcript is split at that position with appropriate timestamps.
 */
export const doubleEnterSplitExtension = EditorState.transactionFilter.of(
	transcriptSplitFilter
);
