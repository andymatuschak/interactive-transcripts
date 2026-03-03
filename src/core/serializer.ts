import type { TranscriptDirective, SkipMarker } from "../types";

/**
 * Serialize a transcript directive to markdown.
 */
export function serializeDirective(directive: TranscriptDirective): string {
	const attrs: string[] = [];

	if (directive.attributes.start !== undefined) {
		attrs.push(`start=${directive.attributes.start}`);
	}
	if (directive.attributes.end !== undefined) {
		attrs.push(`end=${directive.attributes.end}`);
	}

	const attrStr = attrs.length > 0 ? `{${attrs.join(" ")}}` : "";

	return `:::transcript[${directive.audioPath}]${attrStr}
${directive.content}
:::`;
}

/**
 * Create a new directive for a selection with timestamps.
 */
export function createExcerptDirective(
	original: TranscriptDirective,
	selectedContent: string,
	audioStart: number,
	audioEnd: number
): TranscriptDirective {
	return {
		audioPath: original.audioPath,
		attributes: {
			start: audioStart,
			end: audioEnd,
		},
		content: selectedContent,
		from: 0,
		to: 0,
		contentFrom: 0,
	};
}

/**
 * Insert skip markers into plain text at their positions.
 *
 * Takes text without skip markers and an array of skip markers,
 * and returns the text with skip markers inserted at the correct positions.
 * Ensures proper spacing around skip markers.
 *
 * @param text - Plain text without skip markers
 * @param skips - Skip markers with positions referring to locations in the text
 * @returns Text with :skip{start=X end=Y} markers inserted
 */
export function serializeContentWithSkips(text: string, skips: SkipMarker[]): string {
	if (skips.length === 0) {
		return text;
	}

	// Sort skips by position (descending) so we can insert from end to start
	// This prevents position shifting as we insert markers
	const sortedSkips = [...skips].sort((a, b) => b.position - a.position);

	let result = text;
	for (const skip of sortedSkips) {
		const marker = `:skip{start=${skip.audioStart} end=${skip.audioEnd}}`;
		const pos = Math.min(skip.position, result.length);

		const before = result.slice(0, pos);
		const after = result.slice(pos);

		// Add spaces around marker for visual clarity.
		// Text is normalized (multiple spaces collapsed) during alignment lookup.
		const needSpaceBefore = before.length > 0 && !before.endsWith(" ");
		const needSpaceAfter = after.length > 0 && !after.startsWith(" ");

		result = before
			+ (needSpaceBefore ? " " : "")
			+ marker
			+ (needSpaceAfter ? " " : "")
			+ after;
	}

	return result;
}
