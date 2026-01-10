import { describe, expect, test } from "bun:test";
import { serializeDirective, createExcerptDirective } from "./serializer";
import type { TranscriptDirective } from "../types";

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
