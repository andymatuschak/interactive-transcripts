import type { AlignmentData, AlignedWord } from "../types";

/**
 * Generate a cache key for alignment data.
 * Uses both audioPath and content to support multiple directives referencing
 * the same audio file with different transcript content (e.g., after splitting).
 */
function makeKey(audioPath: string, content: string): string {
	return `${audioPath}\0${content}`;
}

/**
 * In-memory store for alignment data, keyed by (audioPath, content).
 *
 * This supports multiple transcript blocks referencing the same audio file
 * with different content (e.g., after splitting a transcript).
 */
class AlignmentStore {
	private alignments: Map<string, AlignmentData> = new Map();

	/**
	 * Store alignment data for an audio file and content.
	 */
	set(audioPath: string, content: string, data: AlignmentData): void {
		this.alignments.set(makeKey(audioPath, content), data);
	}

	/**
	 * Get alignment data for an audio file and content.
	 */
	get(audioPath: string, content: string): AlignmentData | undefined {
		return this.alignments.get(makeKey(audioPath, content));
	}

	/**
	 * Check if alignment exists for an audio file and content.
	 */
	has(audioPath: string, content: string): boolean {
		return this.alignments.has(makeKey(audioPath, content));
	}

	/**
	 * Remove alignment data for an audio file and content.
	 */
	remove(audioPath: string, content: string): void {
		this.alignments.delete(makeKey(audioPath, content));
	}

	/**
	 * Clear all stored alignments.
	 */
	clear(): void {
		this.alignments.clear();
	}

	/**
	 * Get all words as a flat array with their times.
	 */
	getWords(audioPath: string, content: string): AlignedWord[] {
		const data = this.alignments.get(makeKey(audioPath, content));
		if (!data) return [];

		const words: AlignedWord[] = [];
		for (const segment of data.segments) {
			words.push(...segment.words);
		}
		return words;
	}

	/**
	 * Find the word at a given time.
	 */
	findWordAtTime(audioPath: string, content: string, time: number): AlignedWord | null {
		return this.getWords(audioPath, content).find(w => time >= w.start && time <= w.end) ?? null;
	}

	/**
	 * Find the word index at a given time.
	 */
	findWordIndexAtTime(audioPath: string, content: string, time: number): number {
		return this.getWords(audioPath, content).findIndex(w => time >= w.start && time <= w.end);
	}
}

// Singleton instance
export const alignmentStore = new AlignmentStore();
