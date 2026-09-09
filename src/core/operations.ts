import type { TranscriptDirective, AlignmentData, AlignedSegment, AlignedWord, SkipMarker } from "../types";
import { serializeContentWithSkips, serializeDirective } from "./serializer";

export interface DeleteResult {
	markdown: string;
	alignment: AlignmentData;
}

export interface ReplacementRange {
	startOffset: number;
	endOffset: number;
	insertedText: string;
}

export interface MultiRangeSplitResult {
	replacement: string;
	alignments: Array<{ text: string; alignment: AlignmentData }>;
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

/**
 * Split a transcript directive around multiple replacement ranges.
 * Content between/around the ranges becomes separate transcript blocks,
 * interleaved with the inserted text from each range.
 *
 * @param directive - Directive with clean content (no skip markers)
 * @param alignment - Alignment data for the content
 * @param ranges - Sorted array of replacement ranges (by startOffset)
 */
export function splitTranscriptAtMultipleRanges(
	directive: TranscriptDirective,
	alignment: AlignmentData,
	ranges: ReplacementRange[]
): MultiRangeSplitResult {
	const content = directive.content;

	if (ranges.length === 0) {
		return {
			replacement: serializeDirective(directive),
			alignments: [{ text: content, alignment }],
		};
	}

	// Build N+1 slice boundaries from N ranges
	const sliceBounds: Array<{ start: number; end: number }> = [];
	sliceBounds.push({ start: 0, end: ranges[0]!.startOffset });
	for (let i = 1; i < ranges.length; i++) {
		sliceBounds.push({ start: ranges[i - 1]!.endOffset, end: ranges[i]!.startOffset });
	}
	sliceBounds.push({ start: ranges[ranges.length - 1]!.endOffset, end: content.length });

	// Assign each word to a slice (discard words overlapping any range)
	const sliceWords: Array<Array<{ word: AlignedWord; segIdx: number }>> = sliceBounds.map(() => []);

	for (const { location, textStart } of iterateWords(content, alignment)) {
		const wordText = location.word.word.trim();
		const wordEnd = textStart + wordText.length;

		// Discard words overlapping any range
		const inRange = ranges.some(r => textStart < r.endOffset && wordEnd > r.startOffset);
		if (inRange) continue;

		// Find the slice this word belongs to
		for (let i = 0; i < sliceBounds.length; i++) {
			const bounds = sliceBounds[i]!;
			if (textStart >= bounds.start && textStart < bounds.end) {
				sliceWords[i]!.push({ word: location.word, segIdx: location.segmentIndex });
				break;
			}
		}
	}

	// Interleave directive markdowns with inserted texts
	const parts: string[] = [];
	const alignments: Array<{ text: string; alignment: AlignmentData }> = [];

	for (let i = 0; i < sliceBounds.length; i++) {
		const bounds = sliceBounds[i]!;
		const sliceContent = content.slice(bounds.start, bounds.end).trim();

		if (sliceContent) {
			// Timestamps: first slice uses directive start, last uses directive end
			const startTime = i === 0
				? directive.attributes.start
				: findTimestampAtOffset(content, alignment, ranges[i - 1]!.endOffset);
			const endTime = i === sliceBounds.length - 1
				? directive.attributes.end
				: findTimestampAtOffset(content, alignment, ranges[i]!.startOffset);

			const sliceAlignment = buildSliceAlignment(alignment, sliceContent, sliceWords[i]!);

			const sliceDirective: TranscriptDirective = {
				...directive,
				content: sliceContent,
				attributes: { start: startTime, end: endTime },
			};

			parts.push(serializeDirective(sliceDirective));
			alignments.push({ text: sliceContent, alignment: sliceAlignment });
		}

		// Add inserted text after this slice (except after the last slice)
		if (i < ranges.length) {
			parts.push(ranges[i]!.insertedText);
		}
	}

	return { replacement: parts.join("\n\n"), alignments };
}

/**
 * Build alignment data for a slice of content from assigned words.
 * Groups consecutive words by their original segment index.
 */
function buildSliceAlignment(
	baseAlignment: AlignmentData,
	text: string,
	words: Array<{ word: AlignedWord; segIdx: number }>
): AlignmentData {
	if (words.length === 0) {
		return { ...baseAlignment, text, segments: [] };
	}

	const segments: AlignedSegment[] = [];
	let currentSegIdx = words[0]!.segIdx;
	let currentWords: AlignedWord[] = [words[0]!.word];

	for (let i = 1; i < words.length; i++) {
		if (words[i]!.segIdx === currentSegIdx) {
			currentWords.push(words[i]!.word);
		} else {
			segments.push({
				start: currentWords[0]!.start,
				end: currentWords[currentWords.length - 1]!.end,
				text: currentWords.map(w => w.word).join(""),
				words: currentWords,
			});
			currentSegIdx = words[i]!.segIdx;
			currentWords = [words[i]!.word];
		}
	}
	segments.push({
		start: currentWords[0]!.start,
		end: currentWords[currentWords.length - 1]!.end,
		text: currentWords.map(w => w.word).join(""),
		words: currentWords,
	});

	return { ...baseAlignment, text, segments };
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

/**
 * Result of snapping a selection to word boundaries.
 */
export interface SnappedBoundaries {
	/** Snapped start position in text */
	start: number;
	/** Snapped end position in text */
	end: number;
	/** Audio timestamp at start boundary */
	startTime: number;
	/** Audio timestamp at end boundary */
	endTime: number;
}

/**
 * Snap a selection range to word boundaries.
 *
 * If the selection partially includes a word, it expands to include
 * the entire word. Returns both text positions and audio timestamps.
 */
export function snapToWordBoundaries(
	content: string,
	alignment: AlignmentData,
	selStart: number,
	selEnd: number
): SnappedBoundaries {
	let firstWordStart: number | null = null;
	let firstWordTime: number | null = null;
	let lastWordEnd: number | null = null;
	let lastWordTime: number | null = null;

	for (const { location, textStart } of iterateWords(content, alignment)) {
		const wordText = location.word.word.trim();
		const wordEnd = textStart + wordText.length;

		// Check if this word overlaps with the selection
		const overlaps = textStart < selEnd && wordEnd > selStart;

		if (overlaps) {
			if (firstWordStart === null) {
				firstWordStart = textStart;
				firstWordTime = location.word.start;
			}
			lastWordEnd = wordEnd;
			lastWordTime = location.word.end;
		}
	}

	// If no words overlap, return original selection with estimated times
	if (firstWordStart === null || lastWordEnd === null || firstWordTime === null || lastWordTime === null) {
		const estimatedTime = findTimestampAtOffset(content, alignment, selStart);
		return {
			start: selStart,
			end: selEnd,
			startTime: estimatedTime,
			endTime: estimatedTime,
		};
	}

	return {
		start: firstWordStart,
		end: lastWordEnd,
		startTime: firstWordTime,
		endTime: lastWordTime,
	};
}

/** Epsilon for comparing audio timestamps (10ms) */
const TIME_EPSILON = 0.01;
/** Allow for floating-point error when timestamps differ by exactly the epsilon. */
const TIME_COMPARISON_TOLERANCE = 1e-9;

/**
 * Result of collapsing skips.
 */
export interface CollapsedSkipsResult {
	/** Remaining skip markers after collapsing */
	skips: SkipMarker[];
	/** Potentially modified directive attributes */
	attrs: { start?: number; end?: number };
}

/**
 * Collapse skip markers by merging adjacent ones and absorbing
 * skips at boundaries into directive attributes.
 *
 * - Adjacent skips (where one ends where another starts) are merged
 * - Skip at position 0 is absorbed into attrs.start
 * - Skip at end of content is absorbed into attrs.end
 */
export function collapseSkips(
	skips: SkipMarker[],
	attrs: { start?: number; end?: number },
	contentLength: number
): CollapsedSkipsResult {
	if (skips.length === 0) {
		return { skips: [], attrs: { ...attrs } };
	}

	// Sort skips by position, then chronologically when multiple deletions land
	// at the same text boundary. Repeated Delete operations add the newer range
	// after the existing one even when it occurs earlier in the audio.
	const sortedSkips = [...skips].sort(
		(a, b) => a.position - b.position || a.audioStart - b.audioStart
	);

	// Merge adjacent skips (by audio time, not position)
	const mergedSkips: SkipMarker[] = [];
	const firstSkip = sortedSkips[0];
	if (!firstSkip) {
		return { skips: [], attrs: { ...attrs } };
	}
	let current = { ...firstSkip };

	for (let i = 1; i < sortedSkips.length; i++) {
		const next = sortedSkips[i];
		if (!next) continue;

		// Ranges at the same text boundary came from contiguous text deletions and
		// can become one skipped interval, including any silence between words.
		// Otherwise, merge overlapping or adjacent ranges. Timestamp arithmetic
		// can make an exact 10ms gap slightly larger than 0.01, so include a tiny
		// tolerance.
		const sameTextBoundary = current.position === next.position;
		const audioGap = next.audioStart - current.audioEnd;
		if (sameTextBoundary || audioGap <= TIME_EPSILON + TIME_COMPARISON_TOLERANCE) {
			// Merge: extend current skip to include next
			current.audioEnd = Math.max(current.audioEnd, next.audioEnd);
		} else {
			mergedSkips.push(current);
			current = { ...next };
		}
	}
	mergedSkips.push(current);

	// Now check for boundary absorption
	const newAttrs = { ...attrs };
	const remainingSkips: SkipMarker[] = [];

	for (const skip of mergedSkips) {
		// Skip at position 0 → absorb into start attribute
		if (skip.position === 0) {
			// The skip's audioEnd becomes the new start time
			newAttrs.start = skip.audioEnd;
		}
		// Skip at end of content → absorb into end attribute
		else if (skip.position >= contentLength) {
			// The skip's audioStart becomes the new end time
			newAttrs.end = skip.audioStart;
		}
		else {
			remainingSkips.push(skip);
		}
	}

	return { skips: remainingSkips, attrs: newAttrs };
}

/**
 * Result of deletion with skip marker.
 */
export interface DeleteWithSkipResult {
	/** The serialized directive markdown */
	markdown: string;
	/** Updated alignment data */
	alignment: AlignmentData;
	/** Skip markers in the content */
	skips: SkipMarker[];
	/** Cursor offset in the new content (after word boundary snapping) */
	cursorOffset: number;
}

/**
 * Delete a range from a transcript, using skip markers for middle deletions.
 *
 * - Delete from start: adjusts start timestamp
 * - Delete from end: adjusts end timestamp
 * - Delete from middle: creates a skip marker
 *
 * Also handles existing skip markers, merging them when appropriate.
 */
export function deleteFromTranscriptWithSkip(
	directive: TranscriptDirective,
	alignment: AlignmentData,
	deleteStart: number,
	deleteEnd: number,
	existingSkips: SkipMarker[]
): DeleteWithSkipResult | null {
	const content = directive.content;

	// Snap to word boundaries
	const snapped = snapToWordBoundaries(content, alignment, deleteStart, deleteEnd);

	// Calculate new content with deletion
	const beforeDelete = content.slice(0, snapped.start);
	const afterDelete = content.slice(snapped.end);

	// Normalize whitespace: trim each side and determine how to join
	const trimmedBefore = beforeDelete.trimEnd();
	const trimmedAfter = afterDelete.trimStart();

	if (!trimmedBefore && !trimmedAfter) {
		return null; // Would delete everything
	}

	// Build new content - preserve word boundaries with single space
	let newContent: string;
	if (!trimmedBefore) {
		newContent = trimmedAfter;
	} else if (!trimmedAfter) {
		newContent = trimmedBefore;
	} else {
		// Middle deletion: add single space between parts to preserve word boundaries
		// This ensures alignment text matches what parser will produce on round-trip
		newContent = trimmedBefore + " " + trimmedAfter;
	}

	const isDeleteFromStart = !trimmedBefore;
	const isDeleteFromEnd = !trimmedAfter;

	let newStartTime = directive.attributes.start;
	let newEndTime = directive.attributes.end;
	let newSkips = [...existingSkips];
	let cursorOffset = 0;

	if (isDeleteFromStart) {
		// Delete from start: adjust start time, cursor at start
		newStartTime = snapped.endTime;
		cursorOffset = 0;
	} else if (isDeleteFromEnd) {
		// Delete from end: adjust end time, cursor at end
		newEndTime = snapped.startTime;
		cursorOffset = trimmedBefore.length;
	} else {
		// Delete from middle: create a skip marker
		// Position in new content is at trimmedBefore.length (before the added space)
		// This way the space ends up AFTER the marker: "bat foo:skip{} quux"
		const skipPosition = trimmedBefore.length;
		cursorOffset = trimmedBefore.length;

		// Check if we're deleting content that includes existing skip markers
		// and accumulate their time ranges
		let skipStartTime = snapped.startTime;
		let skipEndTime = snapped.endTime;

		// Find skips within the deleted range and merge their time ranges
		// Use < snapped.end because a skip AT the end position is after the deleted text
		const skipsInRange = existingSkips.filter(skip =>
			skip.position >= snapped.start && skip.position < snapped.end
		);

		for (const skip of skipsInRange) {
			skipStartTime = Math.min(skipStartTime, skip.audioStart);
			skipEndTime = Math.max(skipEndTime, skip.audioEnd);
		}

		// Remove skips that were in the deleted range (keep those outside)
		newSkips = existingSkips.filter(skip =>
			skip.position < snapped.start || skip.position >= snapped.end
		);

		// Remap skips into newContent. Subtracting only the deleted word length
		// is not sufficient here: parsing a serialized skip leaves its visual
		// padding on both sides ("word  followed"), and rebuilding newContent
		// collapses that boundary back to one space. Without accounting for the
		// collapsed whitespace, a skip immediately after the deleted word moves
		// one character into the following word on each repeated deletion.
		const leadingWhitespaceAfterDelete = afterDelete.length - trimmedAfter.length;
		const oldAfterContentStart = snapped.end + leadingWhitespaceAfterDelete;
		const newBoundary = trimmedBefore.length;
		const newAfterContentStart = trimmedBefore && trimmedAfter
			? newBoundary + 1
			: newBoundary;

		newSkips = newSkips.map(skip => {
			if (skip.position < snapped.start) {
				// A skip in whitespace trimmed from the end of the prefix belongs at
				// the deletion boundary.
				return { ...skip, position: Math.min(skip.position, newBoundary) };
			}

			// Skips in the leading whitespace of the suffix also belong at the
			// deletion boundary. Later skips retain their suffix-relative offset.
			const position = skip.position <= oldAfterContentStart
				? newBoundary
				: newAfterContentStart + (skip.position - oldAfterContentStart);
			return { ...skip, position };
		});

		// Add the new skip marker
		newSkips.push({
			position: skipPosition,
			audioStart: skipStartTime,
			audioEnd: skipEndTime,
		});
	}

	// Collapse skips (merge adjacent, absorb at boundaries)
	const collapsed = collapseSkips(newSkips, { start: newStartTime, end: newEndTime }, newContent.length);

	// Build the new content with skip markers
	const contentWithSkips = serializeContentWithSkips(newContent, collapsed.skips);

	// Update alignment data
	const newAlignment = removeWordsFromAlignment(
		alignment,
		snapped.start,
		snapped.end,
		content,
		newContent
	);

	const newDirective: TranscriptDirective = {
		...directive,
		content: contentWithSkips,
		attributes: {
			start: collapsed.attrs.start,
			end: collapsed.attrs.end,
		},
	};

	return {
		markdown: serializeDirective(newDirective),
		alignment: { ...newAlignment, text: newContent },
		skips: collapsed.skips,
		cursorOffset,
	};
}
