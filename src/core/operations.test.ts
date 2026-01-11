import { describe, expect, test } from "bun:test";
import { splitTranscript, splitAlignmentData, splitTranscriptAroundRange } from "./operations";
import type { TranscriptDirective, AlignmentData } from "../types";

describe("splitTranscript", () => {
	const mockAlignment: AlignmentData = {
		audioHash: "abc123",
		transcriptHash: "def456",
		language: "en",
		tool: "stable-ts",
		createdAt: Date.now(),
		text: "Hello world this is a test.",
		segments: [
			{
				start: 0,
				end: 3,
				text: "Hello world this is a test.",
				words: [
					{ word: "Hello", start: 0, end: 0.5 },
					{ word: "world", start: 0.5, end: 1.0 },
					{ word: "this", start: 1.0, end: 1.3 },
					{ word: "is", start: 1.3, end: 1.5 },
					{ word: "a", start: 1.5, end: 1.6 },
					{ word: "test.", start: 1.6, end: 2.0 },
				],
			},
		],
	};

	test("splits transcript at word boundary", () => {
		const directive: TranscriptDirective = {
			audioPath: "recording.m4a",
			attributes: { start: 0, end: 3 },
			content: "Hello world this is a test.",
			from: 0,
			to: 100,
			contentFrom: 30,
		};

		// Split after "Hello world " (offset 12)
		const result = splitTranscript(directive, mockAlignment, 12);

		expect(result.beforeMarkdown).toContain("Hello world");
		expect(result.beforeMarkdown).toContain("end=1");
		expect(result.afterMarkdown).toContain("this is a test.");
		expect(result.afterMarkdown).toContain("start=1");
	});

	test("handles split at beginning", () => {
		const directive: TranscriptDirective = {
			audioPath: "audio.m4a",
			attributes: { start: 5, end: 10 },
			content: "Hello world",
			from: 0,
			to: 50,
			contentFrom: 20,
		};

		const result = splitTranscript(directive, mockAlignment, 0);

		expect(result.beforeMarkdown).toContain(":::transcript[audio.m4a]");
		expect(result.afterMarkdown).toContain("Hello world");
	});

	test("preserves audio path", () => {
		const directive: TranscriptDirective = {
			audioPath: "subfolder/my-audio.m4a",
			attributes: { start: 0, end: 5 },
			content: "Hello world",
			from: 0,
			to: 50,
			contentFrom: 25,
		};

		const result = splitTranscript(directive, mockAlignment, 6);

		expect(result.beforeMarkdown).toContain("[subfolder/my-audio.m4a]");
		expect(result.afterMarkdown).toContain("[subfolder/my-audio.m4a]");
	});

	test("handles directive without start/end attributes", () => {
		const directive: TranscriptDirective = {
			audioPath: "audio.m4a",
			attributes: {},
			content: "Hello world this is a test.",
			from: 0,
			to: 100,
			contentFrom: 20,
		};

		const result = splitTranscript(directive, mockAlignment, 12);

		// Before should have end but no start (undefined)
		expect(result.beforeMarkdown).toContain("end=");
		// After should have start but no end (undefined)
		expect(result.afterMarkdown).toContain("start=");
	});

	test("returns split alignment data", () => {
		const directive: TranscriptDirective = {
			audioPath: "recording.m4a",
			attributes: { start: 0, end: 3 },
			content: "Hello world this is a test.",
			from: 0,
			to: 100,
			contentFrom: 30,
		};

		// Split after "Hello world " (offset 12) - "this" starts at offset 12
		const result = splitTranscript(directive, mockAlignment, 12);

		// Before alignment should have "Hello world" words
		expect(result.beforeAlignment.segments.length).toBeGreaterThan(0);
		const beforeWords = result.beforeAlignment.segments.flatMap(s => s.words);
		expect(beforeWords.map(w => w.word)).toEqual(["Hello", "world"]);
		expect(beforeWords[0]!.start).toBe(0);
		expect(beforeWords[1]!.end).toBe(1.0);

		// After alignment should have "this is a test." words
		expect(result.afterAlignment.segments.length).toBeGreaterThan(0);
		const afterWords = result.afterAlignment.segments.flatMap(s => s.words);
		expect(afterWords.map(w => w.word)).toEqual(["this", "is", "a", "test."]);
		expect(afterWords[0]!.start).toBe(1.0);
		expect(afterWords[3]!.end).toBe(2.0);
	});
});

describe("splitAlignmentData", () => {
	const mockAlignment: AlignmentData = {
		audioHash: "abc123",
		transcriptHash: "def456",
		language: "en",
		tool: "stable-ts",
		createdAt: Date.now(),
		text: "Hello world this is a test.",
		segments: [
			{
				start: 0,
				end: 1.0,
				text: "Hello world",
				words: [
					{ word: "Hello", start: 0, end: 0.5 },
					{ word: "world", start: 0.5, end: 1.0 },
				],
			},
			{
				start: 1.0,
				end: 2.0,
				text: "this is a test.",
				words: [
					{ word: "this", start: 1.0, end: 1.3 },
					{ word: "is", start: 1.3, end: 1.5 },
					{ word: "a", start: 1.5, end: 1.6 },
					{ word: "test.", start: 1.6, end: 2.0 },
				],
			},
		],
	};

	test("splits within a segment", () => {
		const content = "Hello world this is a test.";
		// Split after "Hello " (offset 6) - "world" starts at offset 6
		const { before, after } = splitAlignmentData(
			mockAlignment,
			content,
			6,
			"Hello",
			"world this is a test."
		);

		// Before should have just "Hello"
		const beforeWords = before.segments.flatMap(s => s.words);
		expect(beforeWords.map(w => w.word)).toEqual(["Hello"]);
		expect(before.text).toBe("Hello");

		// After should have "world" through "test."
		const afterWords = after.segments.flatMap(s => s.words);
		expect(afterWords.map(w => w.word)).toEqual(["world", "this", "is", "a", "test."]);
		expect(after.text).toBe("world this is a test.");
	});

	test("splits at segment boundary", () => {
		const content = "Hello world this is a test.";
		// Split after "Hello world " (offset 12) - "this" starts at offset 12
		const { before, after } = splitAlignmentData(
			mockAlignment,
			content,
			12,
			"Hello world",
			"this is a test."
		);

		// Before should have first segment
		expect(before.segments.length).toBe(1);
		const beforeWords = before.segments.flatMap(s => s.words);
		expect(beforeWords.map(w => w.word)).toEqual(["Hello", "world"]);

		// After should have second segment
		expect(after.segments.length).toBe(1);
		const afterWords = after.segments.flatMap(s => s.words);
		expect(afterWords.map(w => w.word)).toEqual(["this", "is", "a", "test."]);
	});

	test("handles split at end (all content in before)", () => {
		const content = "Hello world this is a test.";
		const { before, after } = splitAlignmentData(
			mockAlignment,
			content,
			content.length,
			content,
			""
		);

		// All words in before
		const beforeWords = before.segments.flatMap(s => s.words);
		expect(beforeWords.length).toBe(6);

		// No words in after
		expect(after.segments.length).toBe(0);
	});

	test("preserves alignment metadata", () => {
		const content = "Hello world this is a test.";
		const { before, after } = splitAlignmentData(
			mockAlignment,
			content,
			12,
			"Hello world",
			"this is a test."
		);

		// Both should preserve original metadata
		expect(before.audioHash).toBe("abc123");
		expect(before.transcriptHash).toBe("def456");
		expect(before.language).toBe("en");
		expect(before.tool).toBe("stable-ts");

		expect(after.audioHash).toBe("abc123");
		expect(after.transcriptHash).toBe("def456");
		expect(after.language).toBe("en");
		expect(after.tool).toBe("stable-ts");
	});

	test("updates segment start/end times when splitting within segment", () => {
		const content = "Hello world this is a test.";
		// Split after "Hello " - within first segment
		const { before, after } = splitAlignmentData(
			mockAlignment,
			content,
			6,
			"Hello",
			"world this is a test."
		);

		// Before segment should end at "Hello" word end time
		expect(before.segments[0]!.end).toBe(0.5);

		// After's first segment (split from first) should start at "world" start time
		expect(after.segments[0]!.start).toBe(0.5);
	});
});

describe("splitTranscriptAroundRange", () => {
	const mockAlignment: AlignmentData = {
		audioHash: "abc123",
		transcriptHash: "def456",
		language: "en",
		tool: "stable-ts",
		createdAt: Date.now(),
		text: "Hello world this is a test.",
		segments: [
			{
				start: 0,
				end: 2.0,
				text: "Hello world this is a test.",
				words: [
					{ word: "Hello", start: 0, end: 0.5 },
					{ word: "world", start: 0.5, end: 1.0 },
					{ word: "this", start: 1.0, end: 1.3 },
					{ word: "is", start: 1.3, end: 1.5 },
					{ word: "a", start: 1.5, end: 1.6 },
					{ word: "test.", start: 1.6, end: 2.0 },
				],
			},
		],
	};

	test("splits around a range in the middle", () => {
		const directive: TranscriptDirective = {
			audioPath: "recording.m4a",
			attributes: { start: 0, end: 3 },
			content: "Hello world this is a test.",
			from: 0,
			to: 100,
			contentFrom: 30,
		};

		// Remove "world this " (offset 6 to 17)
		const result = splitTranscriptAroundRange(directive, mockAlignment, 6, 17);

		expect(result.beforeMarkdown).toContain("Hello");
		expect(result.afterMarkdown).toContain("is a test.");

		// Before alignment should have "Hello"
		expect(result.beforeAlignment).not.toBeNull();
		const beforeWords = result.beforeAlignment!.segments.flatMap(s => s.words);
		expect(beforeWords.map(w => w.word)).toEqual(["Hello"]);

		// After alignment should have "is", "a", "test."
		expect(result.afterAlignment).not.toBeNull();
		const afterWords = result.afterAlignment!.segments.flatMap(s => s.words);
		expect(afterWords.map(w => w.word)).toEqual(["is", "a", "test."]);
	});

	test("returns null alignments when no content remains", () => {
		const directive: TranscriptDirective = {
			audioPath: "recording.m4a",
			attributes: { start: 0, end: 3 },
			content: "Hello world",
			from: 0,
			to: 100,
			contentFrom: 30,
		};

		// Remove everything
		const result = splitTranscriptAroundRange(directive, mockAlignment, 0, 11);

		expect(result.beforeAlignment).toBeNull();
		expect(result.afterAlignment).toBeNull();
	});
});
