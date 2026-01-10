import { describe, expect, test, beforeEach } from "bun:test";
import { alignmentStore } from "./alignmentStore";
import type { AlignmentData } from "../types";

const createMockAlignment = (word: string): AlignmentData => ({
	segments: [
		{
			text: word,
			start: 0,
			end: 1,
			words: [{ word, start: 0, end: 1 }],
		},
	],
	audioHash: "abc123",
	transcriptHash: "def456",
	language: "en",
	tool: "stable-ts",
	text: word,
	createdAt: Date.now(),
});

describe("alignmentStore", () => {
	beforeEach(() => {
		alignmentStore.clear();
	});

	test("stores and retrieves alignment by audioPath and content", () => {
		const data = createMockAlignment("hello");
		alignmentStore.set("audio.m4a", "hello world", data);

		expect(alignmentStore.has("audio.m4a", "hello world")).toBe(true);
		expect(alignmentStore.get("audio.m4a", "hello world")).toEqual(data);
	});

	test("returns undefined for non-existent alignment", () => {
		expect(alignmentStore.has("audio.m4a", "content")).toBe(false);
		expect(alignmentStore.get("audio.m4a", "content")).toBeUndefined();
	});

	test("supports same audio with different content (split transcripts)", () => {
		const data1 = createMockAlignment("hello");
		const data2 = createMockAlignment("world");

		alignmentStore.set("audio.m4a", "hello", data1);
		alignmentStore.set("audio.m4a", "world", data2);

		expect(alignmentStore.has("audio.m4a", "hello")).toBe(true);
		expect(alignmentStore.has("audio.m4a", "world")).toBe(true);
		expect(alignmentStore.get("audio.m4a", "hello")).toEqual(data1);
		expect(alignmentStore.get("audio.m4a", "world")).toEqual(data2);
	});

	test("getWords returns flattened word array", () => {
		const data: AlignmentData = {
			segments: [
				{
					text: "hello world",
					start: 0,
					end: 2,
					words: [
						{ word: "hello", start: 0, end: 1 },
						{ word: "world", start: 1, end: 2 },
					],
				},
			],
			audioHash: "abc",
			transcriptHash: "def",
			language: "en",
			tool: "stable-ts",
			text: "hello world",
			createdAt: Date.now(),
		};
		alignmentStore.set("audio.m4a", "hello world", data);

		const words = alignmentStore.getWords("audio.m4a", "hello world");
		expect(words).toHaveLength(2);
		expect(words[0]?.word).toBe("hello");
		expect(words[1]?.word).toBe("world");
	});

	test("getWords returns empty array for non-existent alignment", () => {
		const words = alignmentStore.getWords("audio.m4a", "content");
		expect(words).toEqual([]);
	});

	test("findWordAtTime finds correct word", () => {
		const data: AlignmentData = {
			segments: [
				{
					text: "hello world",
					start: 0,
					end: 2,
					words: [
						{ word: "hello", start: 0, end: 1 },
						{ word: "world", start: 1.5, end: 2.5 },
					],
				},
			],
			audioHash: "abc",
			transcriptHash: "def",
			language: "en",
			tool: "stable-ts",
			text: "hello world",
			createdAt: Date.now(),
		};
		alignmentStore.set("audio.m4a", "hello world", data);

		expect(alignmentStore.findWordAtTime("audio.m4a", "hello world", 0.5)?.word).toBe("hello");
		expect(alignmentStore.findWordAtTime("audio.m4a", "hello world", 2)?.word).toBe("world");
		expect(alignmentStore.findWordAtTime("audio.m4a", "hello world", 1.2)).toBeNull(); // Gap
	});

	test("remove deletes alignment", () => {
		const data = createMockAlignment("hello");
		alignmentStore.set("audio.m4a", "hello", data);
		expect(alignmentStore.has("audio.m4a", "hello")).toBe(true);

		alignmentStore.remove("audio.m4a", "hello");
		expect(alignmentStore.has("audio.m4a", "hello")).toBe(false);
	});

	test("clear removes all alignments", () => {
		alignmentStore.set("a.m4a", "content1", createMockAlignment("a"));
		alignmentStore.set("b.m4a", "content2", createMockAlignment("b"));

		alignmentStore.clear();

		expect(alignmentStore.has("a.m4a", "content1")).toBe(false);
		expect(alignmentStore.has("b.m4a", "content2")).toBe(false);
	});
});
