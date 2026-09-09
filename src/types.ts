/**
 * A parsed transcript directive from the markdown.
 *
 * Syntax: :::transcript[filename.m4a]{start=0.052 end=10.847}
 */
export interface TranscriptDirective {
	/** Audio file path from [filename.m4a] */
	audioPath: string;
	/** Vault path of the note containing the directive, when known. */
	sourcePath?: string;
	/** Optional time bounds (floating-point seconds, e.g., 5.123) */
	attributes: {
		start?: number;
		end?: number;
	};
	/** The transcript text content between ::: fences */
	content: string;
	/** Start position in source document (byte offset) */
	from: number;
	/** End position in source document (byte offset) */
	to: number;
	/** Start position of content within the document (after opening fence) */
	contentFrom: number;
}

/**
 * A skip marker within transcript content.
 *
 * Syntax: :skip{start=10.5 end=15.2}
 */
export interface SkipMarker {
	/** Character offset within the transcript content */
	position: number;
	/** Audio time to skip from (floating-point seconds) */
	audioStart: number;
	/** Audio time to skip to (floating-point seconds) */
	audioEnd: number;
}

/**
 * Word-level alignment data for a single word.
 */
export interface AlignedWord {
	word: string;
	/** Start time (floating-point seconds, e.g., 1.234) */
	start: number;
	/** End time (floating-point seconds) */
	end: number;
	confidence?: number;
}

/**
 * A segment of aligned words (typically a sentence/phrase).
 */
export interface AlignedSegment {
	start: number;
	end: number;
	text: string;
	words: AlignedWord[];
}

/**
 * Complete alignment data for an audio file.
 */
export interface AlignmentData {
	audioHash: string;
	transcriptHash: string;
	language: string;
	tool: string;
	createdAt: number;
	segments: AlignedSegment[];
	text: string;
}
