import { describe, expect, test } from "bun:test";
import { reconcileAlignmentToText } from "./reconcile";
import type { AlignmentData } from "../types";

function alignment(words: Array<{ word: string; start: number; end: number }>): AlignmentData {
	return {
		audioHash: "audio",
		transcriptHash: "transcript",
		language: "en",
		tool: "parakeet-mlx",
		createdAt: 1,
		text: words.map(w => w.word).join(" "),
		segments: [
			{
				start: words[0]?.start ?? 0,
				end: words[words.length - 1]?.end ?? 0,
				text: words.map(w => w.word).join(" "),
				words,
			},
		],
	};
}

describe("reconcileAlignmentToText", () => {
	test("preserves timings for punctuation and case-only edits", () => {
		const source = alignment([
			{ word: "hello", start: 0, end: 0.4 },
			{ word: "world", start: 0.5, end: 1.0 },
		]);

		const result = reconcileAlignmentToText(source, "Hello, world!");

		expect(result).not.toBeNull();
		const words = result!.alignment.segments.flatMap(segment => segment.words);
		expect(words.map(word => word.word)).toEqual(["Hello,", "world!"]);
		expect(words.map(word => [word.start, word.end])).toEqual([[0, 0.4], [0.5, 1.0]]);
	});

	test("interpolates short insertions between anchored words", () => {
		const source = alignment([
			{ word: "hello", start: 0, end: 0.4 },
			{ word: "world", start: 1.0, end: 1.4 },
		]);

		const result = reconcileAlignmentToText(source, "hello brave world");

		expect(result).not.toBeNull();
		const words = result!.alignment.segments.flatMap(segment => segment.words);
		expect(words.map(word => word.word)).toEqual(["hello", "brave", "world"]);
		expect(words[1]!.start).toBeGreaterThanOrEqual(0.4);
		expect(words[1]!.end).toBeLessThanOrEqual(1.0);
	});

	test("rejects unrelated text", () => {
		const source = alignment([
			{ word: "hello", start: 0, end: 0.4 },
			{ word: "world", start: 0.5, end: 1.0 },
		]);

		const result = reconcileAlignmentToText(source, "a completely different paragraph appears here");

		expect(result).toBeNull();
	});
});
