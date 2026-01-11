import type { TranscriptDirective, AlignmentData } from "../types";
import { serializeDirective } from "./serializer";

export interface SplitResult {
	beforeMarkdown: string;
	afterMarkdown: string;
}

/**
 * Split a transcript directive at a given offset within its content.
 * Returns two new directive markdown strings with appropriate timestamps.
 */
export function splitTranscript(
	directive: TranscriptDirective,
	alignment: AlignmentData,
	splitOffset: number
): SplitResult {
	// Split content at the offset
	const beforeContent = directive.content.slice(0, splitOffset).trim();
	const afterContent = directive.content.slice(splitOffset).trim();

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
	};
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
	let textOffset = 0;
	let lastEnd = alignment.segments[0]?.start ?? 0;

	for (const segment of alignment.segments) {
		for (const word of segment.words) {
			// Find where this word appears in the content
			const wordText = word.word.trim();
			const wordStart = content.indexOf(wordText, textOffset);

			if (wordStart < 0) continue;

			const wordEnd = wordStart + wordText.length;
			textOffset = wordEnd;

			// If we've reached or passed the split offset, return this word's start time
			if (wordStart >= offset) {
				return word.start;
			}

			lastEnd = word.end;
		}
	}

	// If offset is past all words, return the last end time
	return lastEnd;
}
