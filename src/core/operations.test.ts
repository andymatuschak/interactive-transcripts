import { describe, expect, test } from "bun:test";
import {
	splitTranscript,
	splitAlignmentData,
	splitTranscriptAroundRange,
	splitTranscriptAtMultipleRanges,
	deleteFromTranscript,
	snapToWordBoundaries,
	collapseSkips,
	deleteFromTranscriptWithSkip,
} from "./operations";
import type { TranscriptDirective, AlignmentData, SkipMarker } from "../types";

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

describe("deleteFromTranscript", () => {
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

	const baseDirective: TranscriptDirective = {
		audioPath: "recording.m4a",
		attributes: { start: 0, end: 2.0 },
		content: "Hello world this is a test.",
		from: 0,
		to: 100,
		contentFrom: 30,
	};

	test("deletes from start and adjusts start time", () => {
		// Delete "Hello " (offset 0 to 6)
		const result = deleteFromTranscript(baseDirective, mockAlignment, 0, 6);

		expect(result).not.toBeNull();
		expect(result!.markdown).toContain("start=0.5"); // "world" starts at 0.5
		expect(result!.markdown).toContain("end=2"); // end unchanged
		expect(result!.markdown).toContain("world this is a test.");
		expect(result!.alignment.text).toBe("world this is a test.");

		// Alignment should not include "Hello"
		const words = result!.alignment.segments.flatMap(s => s.words);
		expect(words.map(w => w.word)).toEqual(["world", "this", "is", "a", "test."]);
	});

	test("deletes from end and adjusts end time", () => {
		// Delete " test." (offset 21 to 27)
		const result = deleteFromTranscript(baseDirective, mockAlignment, 21, 27);

		expect(result).not.toBeNull();
		expect(result!.markdown).toContain("start=0"); // start unchanged
		expect(result!.markdown).toContain("end=1.6"); // "a" ends at 1.6
		expect(result!.markdown).toContain("Hello world this is a");

		// Alignment should not include "test."
		const words = result!.alignment.segments.flatMap(s => s.words);
		expect(words.map(w => w.word)).toEqual(["Hello", "world", "this", "is", "a"]);
	});

	test("deletes from middle and preserves timestamps", () => {
		// Delete "this is " (offset 12 to 20)
		const result = deleteFromTranscript(baseDirective, mockAlignment, 12, 20);

		expect(result).not.toBeNull();
		expect(result!.markdown).toContain("start=0"); // start unchanged
		expect(result!.markdown).toContain("end=2"); // end unchanged
		expect(result!.markdown).toContain("Hello world a test.");

		// Alignment should not include "this" or "is"
		const words = result!.alignment.segments.flatMap(s => s.words);
		expect(words.map(w => w.word)).toEqual(["Hello", "world", "a", "test."]);
	});

	test("returns null when deleting everything", () => {
		// Delete entire content
		const result = deleteFromTranscript(baseDirective, mockAlignment, 0, 27);

		expect(result).toBeNull();
	});

	test("preserves alignment metadata", () => {
		const result = deleteFromTranscript(baseDirective, mockAlignment, 0, 6);

		expect(result).not.toBeNull();
		expect(result!.alignment.audioHash).toBe("abc123");
		expect(result!.alignment.transcriptHash).toBe("def456");
		expect(result!.alignment.language).toBe("en");
		expect(result!.alignment.tool).toBe("stable-ts");
	});

	test("handles deletion of single word", () => {
		// Delete "world " (offset 6 to 12)
		const result = deleteFromTranscript(baseDirective, mockAlignment, 6, 12);

		expect(result).not.toBeNull();
		expect(result!.markdown).toContain("Hello this is a test.");

		const words = result!.alignment.segments.flatMap(s => s.words);
		expect(words.map(w => w.word)).toEqual(["Hello", "this", "is", "a", "test."]);
	});

	test("updates segment boundaries after deletion", () => {
		// Delete "this is " from middle
		const result = deleteFromTranscript(baseDirective, mockAlignment, 12, 20);

		expect(result).not.toBeNull();
		// Segment should have updated start/end times based on remaining words
		const segment = result!.alignment.segments[0];
		expect(segment).toBeDefined();
		expect(segment!.start).toBe(0); // First word "Hello" starts at 0
		expect(segment!.end).toBe(2.0); // Last word "test." ends at 2.0
	});
});

describe("snapToWordBoundaries", () => {
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

	const content = "Hello world this is a test.";

	test("expands selection to include partially selected word at start", () => {
		// Selection starts in middle of "Hello" (offset 2) to after "Hello" (offset 5)
		const result = snapToWordBoundaries(content, mockAlignment, 2, 5);

		expect(result.start).toBe(0); // Snap to start of "Hello"
		expect(result.end).toBe(5); // "Hello" ends at offset 5
		expect(result.startTime).toBe(0);
		expect(result.endTime).toBe(0.5);
	});

	test("expands selection to include partially selected word at end", () => {
		// Selection from start of "world" into middle of "this"
		const result = snapToWordBoundaries(content, mockAlignment, 6, 14); // "world th"

		expect(result.start).toBe(6); // Start of "world"
		expect(result.end).toBe(16); // End of "this" (offset 12 + 4 = 16)
		expect(result.startTime).toBe(0.5);
		expect(result.endTime).toBe(1.3);
	});

	test("expands selection that partially overlaps single word", () => {
		// Selection in middle of "world" (offset 8 to 10 - "rl")
		const result = snapToWordBoundaries(content, mockAlignment, 8, 10);

		expect(result.start).toBe(6); // Start of "world"
		expect(result.end).toBe(11); // End of "world"
		expect(result.startTime).toBe(0.5);
		expect(result.endTime).toBe(1.0);
	});

	test("keeps exact word boundary selection unchanged", () => {
		// Select exactly "world" (offset 6 to 11)
		const result = snapToWordBoundaries(content, mockAlignment, 6, 11);

		expect(result.start).toBe(6);
		expect(result.end).toBe(11);
		expect(result.startTime).toBe(0.5);
		expect(result.endTime).toBe(1.0);
	});

	test("expands to include multiple words when selection spans them", () => {
		// Select from middle of "Hello" to middle of "this"
		const result = snapToWordBoundaries(content, mockAlignment, 3, 14);

		expect(result.start).toBe(0); // Start of "Hello"
		expect(result.end).toBe(16); // End of "this"
		expect(result.startTime).toBe(0);
		expect(result.endTime).toBe(1.3);
	});

	test("handles selection at start of content", () => {
		// Select "Hello"
		const result = snapToWordBoundaries(content, mockAlignment, 0, 5);

		expect(result.start).toBe(0);
		expect(result.end).toBe(5);
		expect(result.startTime).toBe(0);
		expect(result.endTime).toBe(0.5);
	});

	test("handles selection at end of content", () => {
		// Select "test." (offset 22 to 27)
		const result = snapToWordBoundaries(content, mockAlignment, 22, 27);

		expect(result.start).toBe(22);
		expect(result.end).toBe(27);
		expect(result.startTime).toBe(1.6);
		expect(result.endTime).toBe(2.0);
	});
});

describe("collapseSkips", () => {
	test("returns empty result for no skips", () => {
		const result = collapseSkips([], { start: 0, end: 10 }, 50);

		expect(result.skips).toHaveLength(0);
		expect(result.attrs.start).toBe(0);
		expect(result.attrs.end).toBe(10);
	});

	test("merges adjacent skips by audio time", () => {
		const skips: SkipMarker[] = [
			{ position: 5, audioStart: 1.0, audioEnd: 2.0 },
			{ position: 10, audioStart: 2.0, audioEnd: 3.0 }, // Adjacent to first
		];

		const result = collapseSkips(skips, { start: 0, end: 10 }, 50);

		expect(result.skips).toHaveLength(1);
		expect(result.skips[0]!.audioStart).toBe(1.0);
		expect(result.skips[0]!.audioEnd).toBe(3.0);
	});

	test("does not merge non-adjacent skips", () => {
		const skips: SkipMarker[] = [
			{ position: 5, audioStart: 1.0, audioEnd: 2.0 },
			{ position: 10, audioStart: 3.0, audioEnd: 4.0 }, // Gap from 2.0 to 3.0
		];

		const result = collapseSkips(skips, { start: 0, end: 10 }, 50);

		expect(result.skips).toHaveLength(2);
	});

	test("absorbs skip at position 0 into start attribute", () => {
		const skips: SkipMarker[] = [
			{ position: 0, audioStart: 0, audioEnd: 2.5 },
		];

		const result = collapseSkips(skips, { start: 0, end: 10 }, 50);

		expect(result.skips).toHaveLength(0);
		expect(result.attrs.start).toBe(2.5); // New start is skip's end
		expect(result.attrs.end).toBe(10);
	});

	test("absorbs skip at end of content into end attribute", () => {
		const skips: SkipMarker[] = [
			{ position: 50, audioStart: 8.0, audioEnd: 10.0 },
		];

		const result = collapseSkips(skips, { start: 0, end: 10 }, 50);

		expect(result.skips).toHaveLength(0);
		expect(result.attrs.start).toBe(0);
		expect(result.attrs.end).toBe(8.0); // New end is skip's start
	});

	test("handles skip at both boundaries", () => {
		const skips: SkipMarker[] = [
			{ position: 0, audioStart: 0, audioEnd: 1.0 },
			{ position: 50, audioStart: 9.0, audioEnd: 10.0 },
		];

		const result = collapseSkips(skips, { start: 0, end: 10 }, 50);

		expect(result.skips).toHaveLength(0);
		expect(result.attrs.start).toBe(1.0);
		expect(result.attrs.end).toBe(9.0);
	});

	test("keeps middle skip while absorbing boundary skips", () => {
		const skips: SkipMarker[] = [
			{ position: 0, audioStart: 0, audioEnd: 1.0 },
			{ position: 25, audioStart: 5.0, audioEnd: 6.0 },
			{ position: 50, audioStart: 9.0, audioEnd: 10.0 },
		];

		const result = collapseSkips(skips, { start: 0, end: 10 }, 50);

		expect(result.skips).toHaveLength(1);
		expect(result.skips[0]!.audioStart).toBe(5.0);
		expect(result.skips[0]!.audioEnd).toBe(6.0);
		expect(result.attrs.start).toBe(1.0);
		expect(result.attrs.end).toBe(9.0);
	});

	test("merges three adjacent skips into one", () => {
		const skips: SkipMarker[] = [
			{ position: 5, audioStart: 1.0, audioEnd: 2.0 },
			{ position: 10, audioStart: 2.0, audioEnd: 3.0 },
			{ position: 15, audioStart: 3.0, audioEnd: 4.0 },
		];

		const result = collapseSkips(skips, { start: 0, end: 10 }, 50);

		expect(result.skips).toHaveLength(1);
		expect(result.skips[0]!.audioStart).toBe(1.0);
		expect(result.skips[0]!.audioEnd).toBe(4.0);
	});
});

describe("splitTranscriptAtMultipleRanges", () => {
	const mockAlignment: AlignmentData = {
		audioHash: "abc123",
		transcriptHash: "def456",
		language: "en",
		tool: "stable-ts",
		createdAt: Date.now(),
		text: "foo bar baz qux quux",
		segments: [
			{
				start: 0,
				end: 5.0,
				text: "foo bar baz qux quux",
				words: [
					{ word: "foo", start: 0, end: 1.0 },
					{ word: "bar", start: 1.0, end: 2.0 },
					{ word: "baz", start: 2.0, end: 3.0 },
					{ word: "qux", start: 3.0, end: 4.0 },
					{ word: "quux", start: 4.0, end: 5.0 },
				],
			},
		],
	};

	const baseDirective: TranscriptDirective = {
		audioPath: "recording.m4a",
		attributes: { start: 0, end: 5.0 },
		content: "foo bar baz qux quux",
		from: 0,
		to: 100,
		contentFrom: 30,
	};

	test("single range in middle → 3 parts", () => {
		// Replace "bar baz" (offset 4 to 11) with "> blockquote"
		const result = splitTranscriptAtMultipleRanges(baseDirective, mockAlignment, [
			{ startOffset: 4, endOffset: 11, insertedText: "> blockquote" },
		]);

		// Should have: before directive, inserted text, after directive
		expect(result.replacement).toContain("foo");
		expect(result.replacement).toContain("> blockquote");
		expect(result.replacement).toContain("qux quux");

		// Two alignment entries (before and after)
		expect(result.alignments).toHaveLength(2);

		// Before alignment: just "foo"
		const beforeWords = result.alignments[0]!.alignment.segments.flatMap(s => s.words);
		expect(beforeWords.map(w => w.word)).toEqual(["foo"]);

		// After alignment: "qux" and "quux"
		const afterWords = result.alignments[1]!.alignment.segments.flatMap(s => s.words);
		expect(afterWords.map(w => w.word)).toEqual(["qux", "quux"]);
	});

	test("two ranges → 5 parts with correct timestamps", () => {
		// Replace "bar" (offset 4 to 7) and "qux" (offset 12 to 15)
		const result = splitTranscriptAtMultipleRanges(baseDirective, mockAlignment, [
			{ startOffset: 4, endOffset: 7, insertedText: "> quote1" },
			{ startOffset: 12, endOffset: 15, insertedText: "> quote2" },
		]);

		// Should contain all parts
		expect(result.replacement).toContain("foo");
		expect(result.replacement).toContain("> quote1");
		expect(result.replacement).toContain("baz");
		expect(result.replacement).toContain("> quote2");
		expect(result.replacement).toContain("quux");

		// Three alignment entries (foo, baz, quux)
		expect(result.alignments).toHaveLength(3);

		const fooWords = result.alignments[0]!.alignment.segments.flatMap(s => s.words);
		expect(fooWords.map(w => w.word)).toEqual(["foo"]);

		const bazWords = result.alignments[1]!.alignment.segments.flatMap(s => s.words);
		expect(bazWords.map(w => w.word)).toEqual(["baz"]);

		const quuxWords = result.alignments[2]!.alignment.segments.flatMap(s => s.words);
		expect(quuxWords.map(w => w.word)).toEqual(["quux"]);

		// Check timestamps: middle slice should have baz timestamps
		expect(result.alignments[1]!.alignment.segments[0]!.start).toBe(2.0);
		expect(result.alignments[1]!.alignment.segments[0]!.end).toBe(3.0);
	});

	test("range at start → no before directive", () => {
		// Replace "foo bar" (offset 0 to 7)
		const result = splitTranscriptAtMultipleRanges(baseDirective, mockAlignment, [
			{ startOffset: 0, endOffset: 7, insertedText: "> replaced" },
		]);

		// Should have: inserted text, after directive
		expect(result.replacement).toContain("> replaced");
		expect(result.replacement).toContain("baz qux quux");

		// Only one alignment entry (after)
		expect(result.alignments).toHaveLength(1);
		const afterWords = result.alignments[0]!.alignment.segments.flatMap(s => s.words);
		expect(afterWords.map(w => w.word)).toEqual(["baz", "qux", "quux"]);
	});

	test("range at end → no after directive", () => {
		// Replace "qux quux" (offset 12 to 20)
		const result = splitTranscriptAtMultipleRanges(baseDirective, mockAlignment, [
			{ startOffset: 12, endOffset: 20, insertedText: "> replaced" },
		]);

		// Should have: before directive, inserted text
		expect(result.replacement).toContain("foo bar baz");
		expect(result.replacement).toContain("> replaced");

		// Only one alignment entry (before)
		expect(result.alignments).toHaveLength(1);
		const beforeWords = result.alignments[0]!.alignment.segments.flatMap(s => s.words);
		expect(beforeWords.map(w => w.word)).toEqual(["foo", "bar", "baz"]);
	});

	test("preserves directive start/end timestamps for outer slices", () => {
		// Replace "baz" (offset 8 to 11)
		const result = splitTranscriptAtMultipleRanges(baseDirective, mockAlignment, [
			{ startOffset: 8, endOffset: 11, insertedText: "> mid" },
		]);

		// Before directive should use directive's start time
		expect(result.replacement).toContain("start=0");
		// After directive should use directive's end time
		expect(result.replacement).toContain("end=5");
	});

	test("empty ranges array returns original directive", () => {
		const result = splitTranscriptAtMultipleRanges(baseDirective, mockAlignment, []);

		expect(result.alignments).toHaveLength(1);
		expect(result.alignments[0]!.text).toBe(baseDirective.content);
	});
});

describe("deleteFromTranscriptWithSkip", () => {
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

	const baseDirective: TranscriptDirective = {
		audioPath: "recording.m4a",
		attributes: { start: 0, end: 2.0 },
		content: "Hello world this is a test.",
		from: 0,
		to: 100,
		contentFrom: 30,
	};

	test("creates skip marker for middle deletion", () => {
		// Delete "world " (offset 6 to 12)
		const result = deleteFromTranscriptWithSkip(baseDirective, mockAlignment, 6, 12, []);

		expect(result).not.toBeNull();
		expect(result!.markdown).toContain(":skip{");
		expect(result!.markdown).toContain("start=0.5"); // "world" starts at 0.5
		expect(result!.markdown).toContain("end=1"); // "world" ends at 1.0
		expect(result!.skips).toHaveLength(1);
	});

	test("adjusts start time for deletion from start (no skip)", () => {
		// Delete "Hello " (offset 0 to 6)
		const result = deleteFromTranscriptWithSkip(baseDirective, mockAlignment, 0, 6, []);

		expect(result).not.toBeNull();
		expect(result!.skips).toHaveLength(0); // No skip for start deletion
		expect(result!.markdown).toContain("start=0.5"); // New start is "world" start
	});

	test("adjusts end time for deletion from end (no skip)", () => {
		// Delete " test." (offset 21 to 27)
		const result = deleteFromTranscriptWithSkip(baseDirective, mockAlignment, 21, 27, []);

		expect(result).not.toBeNull();
		expect(result!.skips).toHaveLength(0); // No skip for end deletion
		expect(result!.markdown).toContain("end=1.6"); // "a" ends at 1.6
	});

	test("snaps partial word selection to word boundaries", () => {
		// Delete partial word "orl" from "world" (offset 7 to 10)
		const result = deleteFromTranscriptWithSkip(baseDirective, mockAlignment, 7, 10, []);

		expect(result).not.toBeNull();
		// Should snap to full "world" word
		expect(result!.markdown).toContain(":skip{start=0.5 end=1}");
	});

	test("merges existing skip with new skip when deleting adjacent content", () => {
		const existingSkips: SkipMarker[] = [
			{ position: 6, audioStart: 0.5, audioEnd: 1.0 }, // Skip for "world"
		];

		// Delete "this " which is adjacent to the existing skip
		// After "world" is skipped, "this" is at position 6 in the cleaned text
		// But we're working with original content offsets
		const result = deleteFromTranscriptWithSkip(
			{ ...baseDirective, content: "Hello world this is a test." },
			mockAlignment,
			12, // Start of "this"
			17, // End of "this "
			existingSkips
		);

		expect(result).not.toBeNull();
		// Should merge the skips since they're adjacent in audio time
		// "world" (0.5-1.0) + "this" (1.0-1.3) = merged skip (0.5-1.3)
	});

	test("returns null when deleting everything", () => {
		const result = deleteFromTranscriptWithSkip(baseDirective, mockAlignment, 0, 27, []);

		expect(result).toBeNull();
	});

	test("preserves alignment metadata", () => {
		const result = deleteFromTranscriptWithSkip(baseDirective, mockAlignment, 6, 12, []);

		expect(result).not.toBeNull();
		expect(result!.alignment.audioHash).toBe("abc123");
		expect(result!.alignment.language).toBe("en");
	});
});
