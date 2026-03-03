import { describe, expect, test } from "bun:test";
import { serializeDirective, createExcerptDirective, serializeContentWithSkips } from "./serializer";
import type { TranscriptDirective, SkipMarker } from "../types";

describe("serializeDirective", () => {
	test("serializes directive with no attributes", () => {
		const directive: TranscriptDirective = {
			audioPath: "recording.m4a",
			attributes: {},
			content: "Hello world.",
			from: 0,
			to: 50,
			contentFrom: 25,
		};

		const result = serializeDirective(directive);
		expect(result).toBe(`:::transcript[recording.m4a]
Hello world.
:::`);
	});

	test("serializes directive with start attribute", () => {
		const directive: TranscriptDirective = {
			audioPath: "audio.m4a",
			attributes: { start: 5.5 },
			content: "Some text.",
			from: 0,
			to: 50,
			contentFrom: 25,
		};

		const result = serializeDirective(directive);
		expect(result).toBe(`:::transcript[audio.m4a]{start=5.5}
Some text.
:::`);
	});

	test("serializes directive with end attribute", () => {
		const directive: TranscriptDirective = {
			audioPath: "audio.m4a",
			attributes: { end: 120.25 },
			content: "Some text.",
			from: 0,
			to: 50,
			contentFrom: 25,
		};

		const result = serializeDirective(directive);
		expect(result).toBe(`:::transcript[audio.m4a]{end=120.25}
Some text.
:::`);
	});

	test("serializes directive with both start and end attributes", () => {
		const directive: TranscriptDirective = {
			audioPath: "recording.m4a",
			attributes: { start: 10.5, end: 45.75 },
			content: "Transcript content here.",
			from: 0,
			to: 100,
			contentFrom: 40,
		};

		const result = serializeDirective(directive);
		expect(result).toBe(`:::transcript[recording.m4a]{start=10.5 end=45.75}
Transcript content here.
:::`);
	});

	test("serializes multiline content", () => {
		const directive: TranscriptDirective = {
			audioPath: "audio.m4a",
			attributes: {},
			content: "Line one.\nLine two.\nLine three.",
			from: 0,
			to: 100,
			contentFrom: 20,
		};

		const result = serializeDirective(directive);
		expect(result).toBe(`:::transcript[audio.m4a]
Line one.
Line two.
Line three.
:::`);
	});

	test("handles zero values for attributes", () => {
		const directive: TranscriptDirective = {
			audioPath: "audio.m4a",
			attributes: { start: 0, end: 60 },
			content: "Content.",
			from: 0,
			to: 50,
			contentFrom: 25,
		};

		const result = serializeDirective(directive);
		expect(result).toBe(`:::transcript[audio.m4a]{start=0 end=60}
Content.
:::`);
	});
});

describe("createExcerptDirective", () => {
	test("creates excerpt with timestamps", () => {
		const original: TranscriptDirective = {
			audioPath: "recording.m4a",
			attributes: { start: 0, end: 120 },
			content: "Full transcript content here.",
			from: 0,
			to: 100,
			contentFrom: 30,
		};

		const excerpt = createExcerptDirective(original, "selected text", 15.5, 25.75);

		expect(excerpt.audioPath).toBe("recording.m4a");
		expect(excerpt.content).toBe("selected text");
		expect(excerpt.attributes.start).toBe(15.5);
		expect(excerpt.attributes.end).toBe(25.75);
	});

	test("preserves audio path from original", () => {
		const original: TranscriptDirective = {
			audioPath: "subfolder/my-audio.m4a",
			attributes: {},
			content: "Original content.",
			from: 0,
			to: 50,
			contentFrom: 25,
		};

		const excerpt = createExcerptDirective(original, "excerpt", 5, 10);

		expect(excerpt.audioPath).toBe("subfolder/my-audio.m4a");
	});
});

describe("serializeContentWithSkips", () => {
	test("returns text unchanged when no skips", () => {
		const result = serializeContentWithSkips("Hello world.", []);
		expect(result).toBe("Hello world.");
	});

	test("inserts single skip marker with spaces on both sides", () => {
		// Skip between two words without spaces - adds spaces on both sides
		const skips: SkipMarker[] = [
			{ position: 4, audioStart: 0.5, audioEnd: 1.5 },
		];
		const result = serializeContentWithSkips("thatwith", skips);
		// Spaces added on both sides for visual clarity
		expect(result).toBe("that :skip{start=0.5 end=1.5} with");
	});

	test("inserts multiple skip markers in correct positions", () => {
		// When content has no spaces, spaces added around each marker
		const skips: SkipMarker[] = [
			{ position: 4, audioStart: 0.5, audioEnd: 1.0 },
			{ position: 9, audioStart: 2.0, audioEnd: 3.0 },
		];
		const result = serializeContentWithSkips("thatworldtest", skips);
		// Note: JavaScript drops trailing zeros (1.0 → 1, 2.0 → 2, 3.0 → 3)
		expect(result).toBe("that :skip{start=0.5 end=1} world :skip{start=2 end=3} test");
	});

	test("handles skip at start of text", () => {
		const skips: SkipMarker[] = [
			{ position: 0, audioStart: 0, audioEnd: 2.5 },
		];
		const result = serializeContentWithSkips("Hello world.", skips);
		// Space added after marker since content follows
		expect(result).toBe(":skip{start=0 end=2.5} Hello world.");
	});

	test("handles skip at end of text", () => {
		const skips: SkipMarker[] = [
			{ position: 12, audioStart: 5.0, audioEnd: 10.0 },
		];
		const result = serializeContentWithSkips("Hello world.", skips);
		// Space added before marker since content precedes
		expect(result).toBe("Hello world. :skip{start=5 end=10}");
	});

	test("handles position beyond text length", () => {
		const skips: SkipMarker[] = [
			{ position: 100, audioStart: 5.0, audioEnd: 10.0 },
		];
		const result = serializeContentWithSkips("Hello.", skips);
		// Space added before marker
		expect(result).toBe("Hello. :skip{start=5 end=10}");
	});

	test("handles unsorted skips correctly", () => {
		// Skips provided out of order should still be inserted correctly
		const skips: SkipMarker[] = [
			{ position: 9, audioStart: 2.0, audioEnd: 3.0 },
			{ position: 4, audioStart: 0.5, audioEnd: 1.0 },
		];
		const result = serializeContentWithSkips("thatworldtest", skips);
		// Note: JavaScript drops trailing zeros
		expect(result).toBe("that :skip{start=0.5 end=1} world :skip{start=2 end=3} test");
	});

	test("preserves decimal precision in timestamps", () => {
		const skips: SkipMarker[] = [
			{ position: 5, audioStart: 1.234, audioEnd: 5.678 },
		];
		const result = serializeContentWithSkips("Hello world.", skips);
		// Position 5 is at space, before ends with 'o', after starts with ' '
		// Space added before (Hello doesn't end with space)
		// No space added after (already has space)
		expect(result).toBe("Hello :skip{start=1.234 end=5.678} world.");
	});

	test("does not add space when before ends with space", () => {
		const skips: SkipMarker[] = [
			{ position: 5, audioStart: 1.0, audioEnd: 2.0 },
		];
		// Position 5 is after "that " (including space)
		const result = serializeContentWithSkips("that with", skips);
		// before="that " ends with space, so no space added before
		// after="with" doesn't start with space, so space added after
		expect(result).toBe("that :skip{start=1 end=2} with");
	});

	test("does not add space when after starts with space", () => {
		const skips: SkipMarker[] = [
			{ position: 4, audioStart: 1.0, audioEnd: 2.0 },
		];
		// Position 4 is after "that", before " with"
		const result = serializeContentWithSkips("that with", skips);
		// before="that" doesn't end with space, so space added before
		// after=" with" starts with space, so no space added after
		expect(result).toBe("that :skip{start=1 end=2} with");
	});

	test("text normalization enables consistent alignment lookup", () => {
		// Import parseContentWithSkips for testing the normalization flow
		const { parseContentWithSkips } = require("./parser");

		// Serialized text has spaces around markers
		const serialized = "Hello :skip{start=0.5 end=1.5} world";
		const parsed = parseContentWithSkips(serialized);

		// Parsed text may have multiple spaces where markers were removed
		// Normalizing collapses them for consistent alignment lookup
		const normalized = parsed.text.replace(/\s+/g, " ").trim();
		expect(normalized).toBe("Hello world");
	});
});
