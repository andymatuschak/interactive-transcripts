import { describe, expect, test, beforeEach } from "bun:test";
import { alignmentStore } from "../alignment/alignmentStore";
import type { AlignmentData, TranscriptDirective } from "../types";

/**
 * This tests the word position finding logic used by highlightSync.
 * We test through the alignmentStore since the actual findWordPosition
 * function is internal to highlightSync.ts.
 *
 * The logic for finding words during playback:
 * - If time is within a word's [start, end], highlight that word
 * - If in a gap < 1 second, keep previous word highlighted
 * - If in a gap >= 1 second, highlight the space between words
 */

const createAlignment = (words: { word: string; start: number; end: number }[]): AlignmentData => ({
	segments: [
		{
			text: words.map(w => w.word).join(" "),
			start: words[0]?.start ?? 0,
			end: words[words.length - 1]?.end ?? 0,
			words,
		},
	],
	audioHash: "abc123",
	transcriptHash: "def456",
	language: "en",
	tool: "parakeet-mlx",
	text: words.map(w => w.word).join(" "),
	createdAt: Date.now(),
});

describe("word position finding", () => {
	beforeEach(() => {
		alignmentStore.clear();
	});

	test("findWordAtTime returns word when time is within word bounds", () => {
		alignmentStore.set("audio.m4a", "hello world", createAlignment([
			{ word: "hello", start: 0, end: 1 },
			{ word: "world", start: 1.5, end: 2.5 },
		]));

		const word = alignmentStore.findWordAtTime("audio.m4a", "hello world", 0.5);
		expect(word?.word).toBe("hello");
	});

	test("findWordAtTime returns null when time is in gap", () => {
		alignmentStore.set("audio.m4a", "hello world", createAlignment([
			{ word: "hello", start: 0, end: 1 },
			{ word: "world", start: 1.5, end: 2.5 },
		]));

		const word = alignmentStore.findWordAtTime("audio.m4a", "hello world", 1.2);
		expect(word).toBeNull();
	});

	test("findWordIndexAtTime returns correct index", () => {
		alignmentStore.set("audio.m4a", "hello world", createAlignment([
			{ word: "hello", start: 0, end: 1 },
			{ word: "world", start: 1.5, end: 2.5 },
		]));

		expect(alignmentStore.findWordIndexAtTime("audio.m4a", "hello world", 0.5)).toBe(0);
		expect(alignmentStore.findWordIndexAtTime("audio.m4a", "hello world", 2)).toBe(1);
		expect(alignmentStore.findWordIndexAtTime("audio.m4a", "hello world", 1.2)).toBe(-1);
	});

	test("handles words with gaps less than 1 second", () => {
		// Gap of 0.5 seconds between words
		alignmentStore.set("audio.m4a", "hello world", createAlignment([
			{ word: "hello", start: 0, end: 1 },
			{ word: "world", start: 1.5, end: 2.5 },
		]));

		// At time 1.2 (in the 0.5s gap), we should return -1
		// The highlightSync logic then keeps the previous word highlighted
		const index = alignmentStore.findWordIndexAtTime("audio.m4a", "hello world", 1.2);
		expect(index).toBe(-1);

		// The calling code should then check gap duration and decide behavior
		const words = alignmentStore.getWords("audio.m4a", "hello world");
		const prevWord = words[0];
		const nextWord = words[1];
		const gapDuration = nextWord!.start - prevWord!.end;
		expect(gapDuration).toBe(0.5);
		expect(gapDuration < 1).toBe(true);
	});

	test("handles words with gaps greater than or equal to 1 second", () => {
		// Gap of 2 seconds between words
		alignmentStore.set("audio.m4a", "hello world", createAlignment([
			{ word: "hello", start: 0, end: 1 },
			{ word: "world", start: 3, end: 4 },
		]));

		const words = alignmentStore.getWords("audio.m4a", "hello world");
		const prevWord = words[0];
		const nextWord = words[1];
		const gapDuration = nextWord!.start - prevWord!.end;
		expect(gapDuration).toBe(2);
		expect(gapDuration >= 1).toBe(true);
	});

	test("handles time before first word", () => {
		alignmentStore.set("audio.m4a", "hello", createAlignment([
			{ word: "hello", start: 1, end: 2 },
		]));

		const word = alignmentStore.findWordAtTime("audio.m4a", "hello", 0.5);
		expect(word).toBeNull();
	});

	test("handles time after last word", () => {
		alignmentStore.set("audio.m4a", "hello", createAlignment([
			{ word: "hello", start: 0, end: 1 },
		]));

		const word = alignmentStore.findWordAtTime("audio.m4a", "hello", 2);
		expect(word).toBeNull();
	});
});
