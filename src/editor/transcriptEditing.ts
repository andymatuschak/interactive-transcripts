import { EditorState, Transaction } from "@codemirror/state";
import { transcriptField } from "./state";
import { livePreviewField } from "./editorMode";
import { alignmentStore } from "../alignment/alignmentStore";
import { splitTranscript, splitTranscriptAroundRange, splitTranscriptAtMultipleRanges, deleteFromTranscriptWithSkip } from "../core/operations";
import type { ReplacementRange } from "../core/operations";
import { parseContentWithSkips, type ParsedContentWithSkips } from "../core/parser";
import type { AlignmentData, TranscriptDirective, SkipMarker } from "../types";

/** Regex to match :skip{start=X end=Y} patterns for offset conversion */
const SKIP_REGEX = /:skip\{start=[\d.]+\s+end=[\d.]+\}/g;

/**
 * Convert an offset from raw content (with skip markers) to clean text (without skip markers).
 * Skip markers before the offset reduce the clean text position.
 */
function rawOffsetToCleanOffset(rawContent: string, rawOffset: number): number {
	let cleanOffset = rawOffset;
	let match;

	SKIP_REGEX.lastIndex = 0;
	while ((match = SKIP_REGEX.exec(rawContent)) !== null) {
		const markerStart = match.index;
		const markerEnd = markerStart + match[0].length;

		if (markerEnd <= rawOffset) {
			// Marker is entirely before the offset - subtract its length
			cleanOffset -= match[0].length;
		} else if (markerStart < rawOffset) {
			// Offset is inside a marker - clamp to marker start
			break;
		}
	}

	return Math.max(0, cleanOffset);
}


/**
 * Context for editing within a transcript block.
 */
interface TranscriptEditContext {
	directive: TranscriptDirective;
	alignment: AlignmentData;
	/** Offset in clean text (raw doc content minus skip markers) */
	startOffset: number;
	/** Offset in clean text (raw doc content minus skip markers) */
	endOffset: number;
	/** Raw document content with skip markers removed (preserves paragraph breaks) */
	cleanText: string;
	/** Skip markers with positions in clean text space */
	cleanSkips: SkipMarker[];
}

/**
 * Read a directive's content exactly as it appears in the document.
 *
 * A container directive's source range includes the line break immediately
 * before its closing `:::` fence. That line break separates the content from
 * the fence; it is not part of the content itself. Keeping it causes a
 * round-trip through serializeDirective() to add a blank line before the
 * closing fence.
 */
function getRawDirectiveContent(state: EditorState, directive: TranscriptDirective): string {
	const contentBeforeClosingFence = state.doc.sliceString(
		directive.contentFrom,
		directive.to - 3
	);

	return contentBeforeClosingFence.endsWith("\n")
		? contentBeforeClosingFence.slice(0, -1)
		: contentBeforeClosingFence;
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

	// Use raw document text to preserve paragraph breaks (\n\n).
	// directive.content is AST-reconstructed and collapses \n\n to \n.
	const rawContent = getRawDirectiveContent(tr.startState, directive);
	const parsed = parseContentWithSkips(rawContent);

	// The alignment store normalizes keys internally, so lookup works
	// regardless of whitespace in the content we pass.
	const alignment = alignmentStore.get(directive.audioPath, parsed.text);
	if (!alignment) return null;

	// Offsets relative to rawContent
	const rawStartOffset = from - directive.contentFrom;
	const rawEndOffset = to - directive.contentFrom;

	if (rawStartOffset < 0 || rawEndOffset > rawContent.length) return null;

	// Convert to clean text space (skip markers removed, paragraph breaks preserved)
	const startOffset = rawOffsetToCleanOffset(rawContent, rawStartOffset);
	const endOffset = rawOffsetToCleanOffset(rawContent, rawEndOffset);

	return { directive, alignment, startOffset, endOffset, cleanText: parsed.text, cleanSkips: parsed.skips };
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
 * - Delete from start/end: adjusts timestamps
 * - Delete from middle: creates a skip marker to preserve audio timeline
 */
function handleDeletion(tr: Transaction): Transaction | null {
	const deleteInfo = findDeletion(tr);
	if (!deleteInfo) return null;

	const ctx = findEditContext(tr, deleteInfo.from, deleteInfo.to);
	if (!ctx) return null;

	const { directive, alignment, startOffset, endOffset, cleanText, cleanSkips } = ctx;

	// Create a directive with clean content (skip markers removed, paragraph breaks preserved)
	const cleanDirective: TranscriptDirective = {
		...directive,
		content: cleanText,
	};

	const result = deleteFromTranscriptWithSkip(
		cleanDirective,
		alignment,
		startOffset,
		endOffset,
		cleanSkips
	);
	if (!result) return null; // Would delete everything

	// Store alignment using normalized text
	const normalizedAlignmentText = result.alignment.text.replace(/\s+/g, " ").trim();
	alignmentStore.set(directive.audioPath, normalizedAlignmentText, {
		...result.alignment,
		text: normalizedAlignmentText,
	});

	// Use the cursor offset from the operation (accounts for word boundary snapping)
	const cursorPos = directive.from + result.markdown.indexOf("\n") + 1 + result.cursorOffset;

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

	const { directive, alignment, startOffset, endOffset, cleanText } = ctx;
	const { inserted } = replaceInfo;

	const cleanDirective: TranscriptDirective = {
		...directive,
		content: cleanText,
	};

	const { beforeMarkdown, afterMarkdown, beforeAlignment, afterAlignment } =
		splitTranscriptAroundRange(cleanDirective, alignment, startOffset, endOffset);

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
 * Handle programmatic (non-user-event) replacements inside transcript blocks.
 * Detects when an external plugin replaces text inside
 * transcript blocks and splits the transcript around each replacement.
 * Supports multiple replacements in a single transaction.
 */
function handleExternalReplacements(tr: Transaction): Transaction | null {
	const { directives } = tr.startState.field(transcriptField);

	// Classify changes: inside transcript vs not
	const directiveChanges = new Map<TranscriptDirective, Array<{
		fromA: number; toA: number; inserted: string;
	}>>();
	const nonTranscriptChanges: Array<{
		from: number; to: number; insert: string;
	}> = [];

	tr.changes.iterChanges((fromA, toA, _fromB, _toB, inserted) => {
		const insertedText = inserted.toString();

		// Only handle actual replacements that insert non-whitespace.
		// Pure insertions (fromA === toA) are not external plugin replacements —
		// they're more likely paste operations routed without a user event.
		if (fromA === toA || !/\S/.test(insertedText)) {
			nonTranscriptChanges.push({ from: fromA, to: toA, insert: insertedText });
			return;
		}

		// Find which directive this change falls in
		const directive = directives.find(
			(d: TranscriptDirective) => fromA >= d.contentFrom && toA <= d.to - 3
		);

		if (!directive) {
			nonTranscriptChanges.push({ from: fromA, to: toA, insert: insertedText });
			return;
		}

		if (!directiveChanges.has(directive)) {
			directiveChanges.set(directive, []);
		}
		directiveChanges.get(directive)!.push({ fromA, toA, inserted: insertedText });
	});

	// No transcript changes → nothing to do
	if (directiveChanges.size === 0) return null;

	// Process each affected directive
	const replacementChanges: Array<{ from: number; to: number; insert: string }> = [];

	for (const [directive, changes] of directiveChanges) {
		// Get raw content and parse skip markers
		const rawContent = getRawDirectiveContent(tr.startState, directive);
		const parsed = parseContentWithSkips(rawContent);

		const alignment = alignmentStore.get(directive.audioPath, parsed.text);
		if (!alignment) {
			// No alignment → pass through original changes
			for (const change of changes) {
				nonTranscriptChanges.push({ from: change.fromA, to: change.toA, insert: change.inserted });
			}
			continue;
		}

		// Convert doc positions to clean-text offsets, sorted by position
		const ranges: ReplacementRange[] = changes
			.sort((a, b) => a.fromA - b.fromA)
			.map(change => {
				const rawStart = change.fromA - directive.contentFrom;
				const rawEnd = change.toA - directive.contentFrom;
				return {
					startOffset: rawOffsetToCleanOffset(rawContent, rawStart),
					endOffset: rawOffsetToCleanOffset(rawContent, rawEnd),
					insertedText: change.inserted,
				};
			});

		const cleanDirective: TranscriptDirective = {
			...directive,
			content: parsed.text,
		};

		const result = splitTranscriptAtMultipleRanges(cleanDirective, alignment, ranges);

		// Store alignments for each resulting block
		for (const { text, alignment: sliceAlignment } of result.alignments) {
			const normalizedText = text.replace(/\s+/g, " ").trim();
			alignmentStore.set(directive.audioPath, normalizedText, {
				...sliceAlignment,
				text: normalizedText,
			});
		}

		replacementChanges.push({
			from: directive.from,
			to: directive.to,
			insert: result.replacement,
		});
	}

	// No directives were actually split → pass through original transaction
	if (replacementChanges.length === 0) return null;

	// Filter out non-transcript changes that overlap with directive replacements
	const filteredNonTranscript = nonTranscriptChanges.filter(change =>
		!replacementChanges.some(r => change.from >= r.from && change.to <= r.from + (r.to - r.from))
	);

	// Build all changes sorted by position
	const allChanges = [...replacementChanges, ...filteredNonTranscript]
		.sort((a, b) => a.from - b.from);

	return tr.startState.update({
		changes: allChanges,
		annotations: Transaction.userEvent.of("input"),
	});
}

/**
 * Transaction filter that intercepts edits in transcript blocks.
 * - Newline at start of line: splits transcript at that position
 * - Text replacement (typing or paste): splits around the replaced range
 * - Deletion: adjusts timestamps and transforms alignment
 * - External plugin replacement: splits around inserted content
 */
function transcriptSplitFilter(tr: Transaction): Transaction | readonly Transaction[] {
	if (!tr.docChanged || tr.startState.field(livePreviewField, false) === false) {
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

	// Handle external plugin replacements (non-user-event)
	if (tr.annotation(Transaction.userEvent) === undefined) {
		const externalResult = handleExternalReplacements(tr);
		if (externalResult) return externalResult;
	}

	// Double-enter split for keyboard input
	if (!tr.isUserEvent("input")) {
		return tr;
	}

	// Check if this transaction inserts a newline
	let newlineInsertPos: number | null = null;
	tr.changes.iterChanges((fromA, toA, _fromB, _toB, inserted) => {
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

	// directive.content is reconstructed from the markdown AST (paragraphs joined
	// by single \n, trimmed), so its offsets don't match document positions.
	// Use the raw document text for finding the newline.
	const rawContent = getRawDirectiveContent(tr.startState, directive);
	const expectedOffset = (newlineInsertPos - 1) - directive.contentFrom;

	// Find the actual newline in raw document content
	const searchOffsets = [expectedOffset, expectedOffset - 1, expectedOffset + 1];
	const splitOffset = searchOffsets.find(
		offset => offset >= 0 && offset < rawContent.length && rawContent[offset] === "\n"
	);

	if (splitOffset === undefined || splitOffset <= 0 || splitOffset >= rawContent.length - 1) {
		return tr;
	}

	// Look up alignment (store normalizes keys internally)
	const alignment = alignmentStore.get(directive.audioPath, rawContent);
	if (!alignment) {
		return tr;
	}

	// Strip skip markers but preserve paragraph breaks for splitting.
	// Using rawParsed.text (not normalizedText) ensures paragraph structure
	// is preserved in the serialized output.
	const rawParsed = parseContentWithSkips(rawContent);
	const rawCleanOffset = rawOffsetToCleanOffset(rawContent, splitOffset);

	const directiveForSplit = {
		...directive,
		content: rawParsed.text,
	};

	const { beforeMarkdown, afterMarkdown, beforeAlignment, afterAlignment } = splitTranscript(
		directiveForSplit,
		alignment,
		rawCleanOffset
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
