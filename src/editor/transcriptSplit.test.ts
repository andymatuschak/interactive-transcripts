import { describe, expect, test, beforeEach } from "bun:test";
import { EditorState, Transaction } from "@codemirror/state";
import { transcriptEditingExtension } from "./transcriptEditing";
import { transcriptField } from "./state";
import { alignmentStore } from "../alignment/alignmentStore";
import type { AlignmentData } from "../types";

/**
 * Helper: create an EditorState with the transcript extensions and alignment.
 */
function createStateWithAlignment(doc: string, audioPath: string, contentText: string, words: { word: string; start: number; end: number }[]) {
	const alignment: AlignmentData = {
		audioHash: "test", transcriptHash: "test", language: "en",
		tool: "test", createdAt: Date.now(), text: contentText,
		segments: [{
			start: words[0]?.start ?? 0,
			end: words[words.length - 1]?.end ?? 10,
			text: contentText,
			words,
		}],
	};
	alignmentStore.set(audioPath, contentText, alignment);

	return EditorState.create({
		doc,
		extensions: [transcriptField, transcriptEditingExtension],
	});
}

/**
 * Simulate pressing Enter (inserting newline) with "input" user event.
 */
function pressEnter(state: EditorState, pos: number): EditorState {
	const tr = state.update({
		changes: { from: pos, insert: "\n" },
		selection: { anchor: pos + 1 },
		userEvent: "input",
	});
	return tr.state;
}

function countTranscriptBlocks(doc: string): number {
	return (doc.match(/:::transcript/g) || []).length;
}

/**
 * Simulate an external (non-user-event) transaction with one or more replacements.
 */
function externalReplace(state: EditorState, changes: Array<{ from: number; to: number; insert: string }>): EditorState {
	const tr = state.update({
		changes,
		// No userEvent annotation → external plugin transaction
	});
	return tr.state;
}

describe("external plugin replacement split", () => {
	beforeEach(() => {
		alignmentStore.clear();
	});

	test("splits transcript around single external replacement", () => {
		const doc = `:::transcript[test.m4a]{start=0 end=5}
foo bar baz qux quux.
:::`;
		const words = [
			{ word: "foo", start: 0, end: 0.5 },
			{ word: " bar", start: 0.5, end: 1 },
			{ word: " baz", start: 1, end: 2 },
			{ word: " qux", start: 2, end: 3 },
			{ word: " quux.", start: 3, end: 5 },
		];

		const state = createStateWithAlignment(doc, "test.m4a", "foo bar baz qux quux.", words);

		// Replace "bar baz" with a blockquote (simulating Quote Leap)
		const replaceFrom = doc.indexOf("bar baz");
		const replaceTo = replaceFrom + "bar baz".length;
		const newState = externalReplace(state, [
			{ from: replaceFrom, to: replaceTo, insert: "> bar baz [link]" },
		]);

		const result = newState.doc.toString();
		expect(countTranscriptBlocks(result)).toBe(2);
		expect(result).toContain("foo");
		expect(result).toContain("> bar baz [link]");
		expect(result).toContain("qux quux.");
	});

	test("splits transcript around multiple external replacements", () => {
		const doc = `:::transcript[test.m4a]{start=0 end=5}
foo bar baz qux quux.
:::`;
		const words = [
			{ word: "foo", start: 0, end: 0.5 },
			{ word: " bar", start: 0.5, end: 1 },
			{ word: " baz", start: 1, end: 2 },
			{ word: " qux", start: 2, end: 3 },
			{ word: " quux.", start: 3, end: 5 },
		];

		const state = createStateWithAlignment(doc, "test.m4a", "foo bar baz qux quux.", words);

		// Replace "bar" and "qux" simultaneously
		const barFrom = doc.indexOf("bar");
		const quxFrom = doc.indexOf("qux");
		const newState = externalReplace(state, [
			{ from: barFrom, to: barFrom + "bar".length, insert: "> quote1" },
			{ from: quxFrom, to: quxFrom + "qux".length, insert: "> quote2" },
		]);

		const result = newState.doc.toString();
		expect(countTranscriptBlocks(result)).toBe(3);
		expect(result).toContain("foo");
		expect(result).toContain("> quote1");
		expect(result).toContain("baz");
		expect(result).toContain("> quote2");
		expect(result).toContain("quux.");
	});

	test("external replacement without alignment passes through unchanged", () => {
		const doc = `:::transcript[test.m4a]{start=0 end=5}
foo bar baz.
:::`;
		// No alignment set up

		const state = EditorState.create({
			doc,
			extensions: [transcriptField, transcriptEditingExtension],
		});

		const replaceFrom = doc.indexOf("bar");
		const replaceTo = replaceFrom + "bar".length;
		const newState = externalReplace(state, [
			{ from: replaceFrom, to: replaceTo, insert: "> replaced" },
		]);

		// Should pass through: the replacement is applied but no split occurs
		const result = newState.doc.toString();
		expect(countTranscriptBlocks(result)).toBe(1);
		expect(result).toContain("> replaced");
	});

	test("external replacement outside transcript passes through", () => {
		const doc = `Some text before.

:::transcript[test.m4a]{start=0 end=5}
foo bar baz.
:::

Some text after.`;
		const words = [
			{ word: "foo", start: 0, end: 0.5 },
			{ word: " bar", start: 0.5, end: 1 },
			{ word: " baz.", start: 1, end: 5 },
		];

		const state = createStateWithAlignment(doc, "test.m4a", "foo bar baz.", words);

		// Replace text outside the transcript
		const replaceFrom = doc.indexOf("Some text before.");
		const replaceTo = replaceFrom + "Some text before.".length;
		const newState = externalReplace(state, [
			{ from: replaceFrom, to: replaceTo, insert: "New text." },
		]);

		const result = newState.doc.toString();
		// Transcript should be unchanged, outside text replaced
		expect(countTranscriptBlocks(result)).toBe(1);
		expect(result).toContain("New text.");
		expect(result).toContain("foo bar baz.");
	});

	test("stores alignment data for split blocks", () => {
		const doc = `:::transcript[test.m4a]{start=0 end=5}
foo bar baz.
:::`;
		const words = [
			{ word: "foo", start: 0, end: 0.5 },
			{ word: " bar", start: 0.5, end: 1 },
			{ word: " baz.", start: 1, end: 5 },
		];

		const state = createStateWithAlignment(doc, "test.m4a", "foo bar baz.", words);

		const replaceFrom = doc.indexOf("bar");
		const replaceTo = replaceFrom + "bar".length;
		externalReplace(state, [
			{ from: replaceFrom, to: replaceTo, insert: "> replaced" },
		]);

		// Should have alignment for the "before" block ("foo")
		const fooAlignment = alignmentStore.get("test.m4a", "foo");
		expect(fooAlignment).toBeDefined();
		expect(fooAlignment!.segments.flatMap(s => s.words).map(w => w.word)).toEqual(["foo"]);

		// Should have alignment for the "after" block ("baz.")
		const bazAlignment = alignmentStore.get("test.m4a", "baz.");
		expect(bazAlignment).toBeDefined();
		expect(bazAlignment!.segments.flatMap(s => s.words).map(w => w.word)).toEqual([" baz."]);
	});
});

describe("double-Enter split", () => {
	beforeEach(() => {
		alignmentStore.clear();
	});

	test("splits single-line transcript at word boundary", () => {
		const doc = `:::transcript[test.m4a]{start=0 end=5}
Hello world foo bar.
:::`;
		const words = [
			{ word: "Hello", start: 0, end: 0.5 },
			{ word: " world", start: 0.5, end: 1 },
			{ word: " foo", start: 1, end: 2 },
			{ word: " bar.", start: 2, end: 5 },
		];

		let state = createStateWithAlignment(doc, "test.m4a", "Hello world foo bar.", words);
		// Cursor at "Hello world ^foo bar." (between space and "foo")
		const cursorPos = doc.indexOf("foo");

		// First Enter
		state = pressEnter(state, cursorPos);
		expect(countTranscriptBlocks(state.doc.toString())).toBe(1);

		// Second Enter
		const cursor2 = state.selection.main.head;
		state = pressEnter(state, cursor2);
		expect(countTranscriptBlocks(state.doc.toString())).toBe(2);
	});

	test("splits multi-paragraph transcript at end of paragraph", () => {
		const doc = `:::transcript[test.m4a]{start=0 end=10}
First paragraph here.

Second paragraph here.
:::`;
		const normalizedContent = "First paragraph here. Second paragraph here.";
		const words = [
			{ word: "First", start: 0, end: 0.5 },
			{ word: " paragraph", start: 0.5, end: 1.5 },
			{ word: " here.", start: 1.5, end: 2 },
			{ word: " Second", start: 5, end: 5.5 },
			{ word: " paragraph", start: 5.5, end: 6.5 },
			{ word: " here.", start: 6.5, end: 10 },
		];

		let state = createStateWithAlignment(doc, "test.m4a", normalizedContent, words);
		// Cursor at end of "First paragraph here." (before the \n\n)
		const cursorPos = doc.indexOf("First paragraph here.") + "First paragraph here.".length;

		// First Enter
		state = pressEnter(state, cursorPos);
		const doc1 = state.doc.toString();
		expect(countTranscriptBlocks(doc1)).toBe(1);

		// Second Enter
		const cursor2 = state.selection.main.head;
		state = pressEnter(state, cursor2);
		const doc2 = state.doc.toString();
		expect(countTranscriptBlocks(doc2)).toBe(2);
	});

	test("splits with cursor before word after space (foo ^bar)", () => {
		const doc = `:::transcript[test.m4a]{start=0 end=5}
Hello world foo bar.
:::`;
		const words = [
			{ word: "Hello", start: 0, end: 0.5 },
			{ word: " world", start: 0.5, end: 1 },
			{ word: " foo", start: 1, end: 2 },
			{ word: " bar.", start: 2, end: 5 },
		];

		let state = createStateWithAlignment(doc, "test.m4a", "Hello world foo bar.", words);
		// Cursor at "Hello world foo ^bar." (right before "bar")
		const cursorPos = doc.indexOf("bar.");

		// First Enter
		state = pressEnter(state, cursorPos);
		expect(countTranscriptBlocks(state.doc.toString())).toBe(1);

		// Second Enter
		const cursor2 = state.selection.main.head;
		state = pressEnter(state, cursor2);
		expect(countTranscriptBlocks(state.doc.toString())).toBe(2);
	});

	test("splits multi-paragraph transcript with many paragraphs (offset drift)", () => {
		// With 3+ paragraph breaks, the offset drift between raw document text
		// (double-newlines) and AST-reconstructed content (single-newlines) exceeds
		// the ±1 search window. This exercises the fix that uses raw document text.
		const doc = `:::transcript[test.m4a]{start=0 end=20}
First paragraph.

Second paragraph.

Third paragraph.

Fourth paragraph.
:::`;
		const normalizedContent = "First paragraph. Second paragraph. Third paragraph. Fourth paragraph.";
		const words = [
			{ word: "First", start: 0, end: 0.5 },
			{ word: " paragraph.", start: 0.5, end: 2 },
			{ word: " Second", start: 3, end: 3.5 },
			{ word: " paragraph.", start: 3.5, end: 5 },
			{ word: " Third", start: 8, end: 8.5 },
			{ word: " paragraph.", start: 8.5, end: 10 },
			{ word: " Fourth", start: 13, end: 13.5 },
			{ word: " paragraph.", start: 13.5, end: 20 },
		];

		let state = createStateWithAlignment(doc, "test.m4a", normalizedContent, words);
		// Cursor at end of "Third paragraph." (after 3 paragraph breaks in raw doc)
		const cursorPos = doc.indexOf("Third paragraph.") + "Third paragraph.".length;

		// First Enter
		state = pressEnter(state, cursorPos);
		expect(countTranscriptBlocks(state.doc.toString())).toBe(1);

		// Second Enter
		const cursor2 = state.selection.main.head;
		state = pressEnter(state, cursor2);
		expect(countTranscriptBlocks(state.doc.toString())).toBe(2);

		// Verify the split produced correct halves with paragraph breaks preserved
		const result = state.doc.toString();
		expect(result).toContain("First paragraph.");
		expect(result).toContain("Fourth paragraph.");
		// The "before" block should preserve paragraph breaks between First/Second/Third
		expect(result).toContain("First paragraph.\n\nSecond paragraph.\n\nThird paragraph.");
	});

	test("splits transcript without start/end attributes", () => {
		const doc = `:::transcript[test.m4a]
Hello world foo bar.
:::`;
		const words = [
			{ word: "Hello", start: 0, end: 0.5 },
			{ word: " world", start: 0.5, end: 1 },
			{ word: " foo", start: 1, end: 2 },
			{ word: " bar.", start: 2, end: 5 },
		];

		let state = createStateWithAlignment(doc, "test.m4a", "Hello world foo bar.", words);
		const cursorPos = doc.indexOf("foo");

		// First Enter
		state = pressEnter(state, cursorPos);
		expect(countTranscriptBlocks(state.doc.toString())).toBe(1);

		// Second Enter
		const cursor2 = state.selection.main.head;
		state = pressEnter(state, cursor2);
		expect(countTranscriptBlocks(state.doc.toString())).toBe(2);
	});
});
