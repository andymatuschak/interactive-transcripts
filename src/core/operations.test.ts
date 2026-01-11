import { describe, expect, test } from "bun:test";
import { splitTranscript } from "./operations";
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
});
