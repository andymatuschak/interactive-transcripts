import type { TranscriptDirective, AlignmentData, AlignedSegment, AlignedWord } from "../types";
import { serializeDirective } from "./serializer";

export interface DeleteResult {
	markdown: string;
	alignment: AlignmentData;
}

export interface SplitResult {
	beforeMarkdown: string;
	afterMarkdown: string;
	beforeAlignment: AlignmentData;
	afterAlignment: AlignmentData;
}

export interface RangeSplitResult {
	beforeMarkdown: string;
	afterMarkdown: string;
	beforeAlignment: AlignmentData | null;
	afterAlignment: AlignmentData | null;
}

/**
 * Split a transcript directive at a given offset within its content.
 * Returns two new directive markdown strings with appropriate timestamps,
 * plus the split alignment data for each part.
 */
export function splitTranscript(
	directive: TranscriptDirective,
	alignment: AlignmentData,
	splitOffset: number
): SplitResult {
	// Split content at the offset
	const beforeContent = directive.content.slice(0, splitOffset).trim();
	const afterContent = directive.content.slice(splitOffset).trim();

	// Split the alignment data
	const { before: beforeAlignment, after: afterAlignment } = splitAlignmentData(
		alignment,
		directive.content,
		splitOffset,
		beforeContent,
		afterContent
	);

	// Find the timestamp at the split point
	const splitTime = findTimestampAtOffset(directive.content, alignment, splitOffset);

	// Create two new directives
	const before: TranscriptDirective = {
		...directive,
		content: beforeContent,
		attributes: {
			start: directive.attributes.start,
			end: splitTime,
		},
	};

	const after: TranscriptDirective = {
		...directive,
		content: afterContent,
		attributes: {
			start: splitTime,
			end: directive.attributes.end,
		},
	};

	return {
		beforeMarkdown: serializeDirective(before),
		afterMarkdown: serializeDirective(after),
		beforeAlignment,
		afterAlignment,
	};
}

/**
 * Split a transcript directive around a range within its content.
 * The content between startOffset and endOffset is removed, and two
 * new directives are created for the content before and after the range.
 * Also returns the split alignment data.
 */
export function splitTranscriptAroundRange(
	directive: TranscriptDirective,
	alignment: AlignmentData,
	startOffset: number,
	endOffset: number
): RangeSplitResult {
	// Get content before and after the range
	const beforeContent = directive.content.slice(0, startOffset).trim();
	const afterContent = directive.content.slice(endOffset).trim();

	// Split alignment at the start boundary (for "before" part)
	const { before: beforeAlignment } = splitAlignmentData(
		alignment,
		directive.content,
		startOffset,
		beforeContent,
		directive.content.slice(startOffset)
	);

	// Split alignment at the end boundary (for "after" part)
	const { after: afterAlignment } = splitAlignmentData(
		alignment,
		directive.content,
		endOffset,
		directive.content.slice(0, endOffset),
		afterContent
	);

	// Find timestamps at the range boundaries
	const startTime = findTimestampAtOffset(directive.content, alignment, startOffset);
	const endTime = findTimestampAtOffset(directive.content, alignment, endOffset);

	// Create the before directive (if there's content)
	const before: TranscriptDirective = {
		...directive,
		content: beforeContent,
		attributes: {
			start: directive.attributes.start,
			end: startTime,
		},
	};

	// Create the after directive (if there's content)
	const after: TranscriptDirective = {
		...directive,
		content: afterContent,
		attributes: {
			start: endTime,
			end: directive.attributes.end,
		},
	};

	return {
		beforeMarkdown: beforeContent ? serializeDirective(before) : "",
		afterMarkdown: afterContent ? serializeDirective(after) : "",
		beforeAlignment: beforeContent ? beforeAlignment : null,
		afterAlignment: afterContent ? afterAlignment : null,
	};
}

interface WordLocation {
	segmentIndex: number;
	wordIndex: number;
	word: AlignedWord;
}

/**
 * Iterate through aligned words, finding their positions in the content.
 * Yields each word's location and text position.
 */
function* iterateWords(
	content: string,
	alignment: AlignmentData
): Generator<{ location: WordLocation; textStart: number }> {
	let textOffset = 0;

	for (let segIdx = 0; segIdx < alignment.segments.length; segIdx++) {
		const segment = alignment.segments[segIdx]!;
		for (let wordIdx = 0; wordIdx < segment.words.length; wordIdx++) {
			const word = segment.words[wordIdx]!;
			const wordText = word.word.trim();
			const wordStart = content.indexOf(wordText, textOffset);

			if (wordStart < 0) continue;

			textOffset = wordStart + wordText.length;
			yield {
				location: { segmentIndex: segIdx, wordIndex: wordIdx, word },
				textStart: wordStart,
			};
		}
	}
}

/**
 * Find the audio timestamp corresponding to a text offset.
 * Returns the start time of the word at or after the offset.
 */
function findTimestampAtOffset(
	content: string,
	alignment: AlignmentData,
	offset: number
): number {
	let lastEnd = alignment.segments[0]?.start ?? 0;

	for (const { location, textStart } of iterateWords(content, alignment)) {
		if (textStart >= offset) {
			return location.word.start;
		}
		lastEnd = location.word.end;
	}

	return lastEnd;
}

/**
 * Find the word index at which to split the alignment.
 * Returns { segmentIndex, wordIndex } for the first word at or after the offset.
 */
function findSplitPoint(
	content: string,
	alignment: AlignmentData,
	offset: number
): { segmentIndex: number; wordIndex: number } | null {
	for (const { location, textStart } of iterateWords(content, alignment)) {
		if (textStart >= offset) {
			return { segmentIndex: location.segmentIndex, wordIndex: location.wordIndex };
		}
	}
	return null;
}

/**
 * Split alignment data at a given point, returning two new AlignmentData objects.
 */
export function splitAlignmentData(
	alignment: AlignmentData,
	content: string,
	splitOffset: number,
	beforeContent: string,
	afterContent: string
): { before: AlignmentData; after: AlignmentData } {
	const splitPoint = findSplitPoint(content, alignment, splitOffset);

	// Build segments for before and after
	const beforeSegments: AlignedSegment[] = [];
	const afterSegments: AlignedSegment[] = [];

	if (!splitPoint) {
		// Split point is at the end - all content goes to "before"
		return {
			before: { ...alignment, text: beforeContent, segments: [...alignment.segments] },
			after: { ...alignment, text: afterContent, segments: [] },
		};
	}

	const { segmentIndex, wordIndex } = splitPoint;

	for (let segIdx = 0; segIdx < alignment.segments.length; segIdx++) {
		const segment = alignment.segments[segIdx]!;

		if (segIdx < segmentIndex) {
			// Entire segment goes to "before"
			beforeSegments.push({ ...segment, words: [...segment.words] });
		} else if (segIdx > segmentIndex) {
			// Entire segment goes to "after"
			afterSegments.push({ ...segment, words: [...segment.words] });
		} else {
			// This segment is split
			const beforeWords = segment.words.slice(0, wordIndex);
			const afterWords = segment.words.slice(wordIndex);

			if (beforeWords.length > 0) {
				const lastBeforeWord = beforeWords[beforeWords.length - 1]!;
				beforeSegments.push({
					start: segment.start,
					end: lastBeforeWord.end,
					text: beforeWords.map(w => w.word).join(""),
					words: beforeWords,
				});
			}

			if (afterWords.length > 0) {
				const firstAfterWord = afterWords[0]!;
				afterSegments.push({
					start: firstAfterWord.start,
					end: segment.end,
					text: afterWords.map(w => w.word).join(""),
					words: afterWords,
				});
			}
		}
	}

	const before: AlignmentData = {
		...alignment,
		text: beforeContent,
		segments: beforeSegments,
	};

	const after: AlignmentData = {
		...alignment,
		text: afterContent,
		segments: afterSegments,
	};

	return { before, after };
}

/**
 * Delete a range from a transcript, returning updated directive and alignment.
 * Handles three cases:
 * - Delete from start: adjusts start timestamp
 * - Delete from end: adjusts end timestamp
 * - Delete from middle (at word boundary): removes words from alignment
 */
export function deleteFromTranscript(
	directive: TranscriptDirective,
	alignment: AlignmentData,
	deleteStart: number,
	deleteEnd: number
): DeleteResult | null {
	const content = directive.content;

	// Calculate new content
	const newContent = (content.slice(0, deleteStart) + content.slice(deleteEnd)).trim();
	if (!newContent) {
		return null; // Would delete everything
	}

	// Determine deletion type based on trimmed positions
	const trimmedStart = content.slice(0, deleteStart).trim();
	const trimmedEnd = content.slice(deleteEnd).trim();

	const isDeleteFromStart = !trimmedStart;
	const isDeleteFromEnd = !trimmedEnd;

	let newStartTime = directive.attributes.start;
	let newEndTime = directive.attributes.end;
	let newAlignment: AlignmentData;

	if (isDeleteFromStart) {
		// Delete from start: new start time is the first remaining word's start
		const firstRemainingWord = findFirstWordAtOrAfter(content, alignment, deleteEnd);
		if (firstRemainingWord) {
			newStartTime = firstRemainingWord.word.start;
		}
		// Remove deleted words from alignment
		newAlignment = removeWordsFromAlignment(alignment, 0, deleteEnd, content, newContent);
	} else if (isDeleteFromEnd) {
		// Delete from end: new end time is the last remaining word's end
		const lastRemainingWord = findLastWordBefore(content, alignment, deleteStart);
		if (lastRemainingWord) {
			newEndTime = lastRemainingWord.word.end;
		}
		// Remove deleted words from alignment
		newAlignment = removeWordsFromAlignment(alignment, deleteStart, content.length, content, newContent);
	} else {
		// Delete from middle: remove words from alignment
		newAlignment = removeWordsFromAlignment(alignment, deleteStart, deleteEnd, content, newContent);
	}

	const newDirective: TranscriptDirective = {
		...directive,
		content: newContent,
		attributes: {
			start: newStartTime,
			end: newEndTime,
		},
	};

	return {
		markdown: serializeDirective(newDirective),
		alignment: newAlignment,
	};
}

/**
 * Find the first word at or after an offset.
 */
function findFirstWordAtOrAfter(
	content: string,
	alignment: AlignmentData,
	offset: number
): WordLocation | null {
	for (const { location, textStart } of iterateWords(content, alignment)) {
		if (textStart >= offset) {
			return location;
		}
	}
	return null;
}

/**
 * Find the last word before an offset.
 */
function findLastWordBefore(
	content: string,
	alignment: AlignmentData,
	offset: number
): WordLocation | null {
	let lastWord: WordLocation | null = null;
	for (const { location, textStart } of iterateWords(content, alignment)) {
		const textEnd = textStart + location.word.word.trim().length;
		if (textEnd <= offset) {
			lastWord = location;
		} else {
			break;
		}
	}
	return lastWord;
}

/**
 * Remove words that fall within a deletion range from alignment.
 */
function removeWordsFromAlignment(
	alignment: AlignmentData,
	deleteStart: number,
	deleteEnd: number,
	oldContent: string,
	newContent: string
): AlignmentData {
	// Build a map of word positions in one pass
	const wordPositions = new Map<AlignedWord, number>();
	for (const { location, textStart } of iterateWords(oldContent, alignment)) {
		wordPositions.set(location.word, textStart);
	}

	const newSegments: AlignedSegment[] = [];

	for (const segment of alignment.segments) {
		const newWords: AlignedWord[] = [];

		for (const word of segment.words) {
			const wordStart = wordPositions.get(word);
			if (wordStart === undefined) {
				// Couldn't find word, keep it
				newWords.push(word);
				continue;
			}

			const wordEnd = wordStart + word.word.trim().length;

			// Keep words outside the deletion range
			if (wordEnd <= deleteStart || wordStart >= deleteEnd) {
				newWords.push(word);
			}
		}

		const firstWord = newWords[0];
		const lastWord = newWords[newWords.length - 1];
		if (firstWord && lastWord) {
			newSegments.push({
				...segment,
				start: firstWord.start,
				end: lastWord.end,
				text: newWords.map(w => w.word).join(""),
				words: newWords,
			});
		}
	}

	return {
		...alignment,
		text: newContent,
		segments: newSegments,
	};
}
