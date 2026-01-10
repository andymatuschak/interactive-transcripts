import type { TranscriptDirective } from "../types";

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
