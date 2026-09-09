import { beforeEach, describe, expect, test } from "bun:test";
import { EditorState, Transaction } from "@codemirror/state";
import { alignmentStore } from "../alignment/alignmentStore";
import type { AlignmentData } from "../types";
import { transcriptField } from "./state";
import { findDeletion, findTextReplacement, transcriptEditingExtension } from "./transcriptEditing";

describe("findDeletion", () => {
	test("detects deletion of text", () => {
		const state = EditorState.create({ doc: "Hello world" });
		const tr = state.update({
			changes: { from: 0, to: 5, insert: "" }, // delete "Hello"
		});

		const result = findDeletion(tr);
		expect(result).toEqual({ from: 0, to: 5 });
	});

	test("detects deletion with whitespace insert", () => {
		const state = EditorState.create({ doc: "Hello world" });
		const tr = state.update({
			changes: { from: 0, to: 5, insert: "   " }, // replace "Hello" with spaces
		});

		const result = findDeletion(tr);
		expect(result).toEqual({ from: 0, to: 5 });
	});

	test("returns null for pure insertion", () => {
		const state = EditorState.create({ doc: "Hello world" });
		const tr = state.update({
			changes: { from: 5, to: 5, insert: " there" }, // insert at position
		});

		const result = findDeletion(tr);
		expect(result).toBeNull();
	});

	test("returns null for replacement (non-whitespace to non-whitespace)", () => {
		const state = EditorState.create({ doc: "Hello world" });
		const tr = state.update({
			changes: { from: 0, to: 5, insert: "Goodbye" }, // replace "Hello" with "Goodbye"
		});

		const result = findDeletion(tr);
		expect(result).toBeNull();
	});

	test("returns null for whitespace-only deletion", () => {
		const state = EditorState.create({ doc: "Hello   world" });
		const tr = state.update({
			changes: { from: 5, to: 8, insert: "" }, // delete spaces
		});

		const result = findDeletion(tr);
		expect(result).toBeNull();
	});
});

describe("findTextReplacement", () => {
	test("detects replacement of text", () => {
		const state = EditorState.create({ doc: "Hello world" });
		const tr = state.update({
			changes: { from: 0, to: 5, insert: "Goodbye" }, // replace "Hello" with "Goodbye"
		});

		const result = findTextReplacement(tr);
		expect(result).toEqual({ from: 0, to: 5, inserted: "Goodbye" });
	});

	test("returns null for pure insertion", () => {
		const state = EditorState.create({ doc: "Hello world" });
		const tr = state.update({
			changes: { from: 5, to: 5, insert: " there" }, // insert at position
		});

		const result = findTextReplacement(tr);
		expect(result).toBeNull();
	});

	test("returns null for pure deletion", () => {
		const state = EditorState.create({ doc: "Hello world" });
		const tr = state.update({
			changes: { from: 0, to: 5, insert: "" }, // delete "Hello"
		});

		const result = findTextReplacement(tr);
		expect(result).toBeNull();
	});

	test("returns null for replacing with whitespace only", () => {
		const state = EditorState.create({ doc: "Hello world" });
		const tr = state.update({
			changes: { from: 0, to: 5, insert: "   " }, // replace "Hello" with spaces
		});

		const result = findTextReplacement(tr);
		expect(result).toBeNull();
	});

	test("returns null for replacing whitespace with text", () => {
		const state = EditorState.create({ doc: "Hello   world" });
		const tr = state.update({
			changes: { from: 5, to: 8, insert: "X" }, // replace spaces with "X"
		});

		const result = findTextReplacement(tr);
		expect(result).toBeNull();
	});
});

describe("transcript deletion", () => {
	const content = "Hello world this is a test.";
	const doc = `:::transcript[recording.m4a]{start=0 end=2}
${content}
:::`;
	const alignment: AlignmentData = {
		audioHash: "audio",
		transcriptHash: "transcript",
		language: "en",
		tool: "test",
		createdAt: 0,
		text: content,
		segments: [{
			start: 0,
			end: 2,
			text: content,
			words: [
				{ word: "Hello", start: 0, end: 0.5 },
				{ word: "world", start: 0.5, end: 1 },
				{ word: "this", start: 1, end: 1.3 },
				{ word: "is", start: 1.3, end: 1.5 },
				{ word: "a", start: 1.5, end: 1.6 },
				{ word: "test.", start: 1.6, end: 2 },
			],
		}],
	};

	beforeEach(() => {
		alignmentStore.clear();
		alignmentStore.set("recording.m4a", content, alignment);
	});

	function deleteRange(from: number, to: number): string {
		const state = EditorState.create({
			doc,
			extensions: [transcriptField, transcriptEditingExtension],
		});

		return state.update({
			changes: { from, to, insert: "" },
			annotations: Transaction.userEvent.of("delete.selection"),
		}).state.doc.toString();
	}

	test("does not add a blank line when deleting from the start", () => {
		const contentFrom = doc.indexOf(content);
		const result = deleteRange(contentFrom, contentFrom + 3);

		expect(result).toBe(`:::transcript[recording.m4a]{start=0.5 end=2}
world this is a test.
:::`);
	});

	test("does not add a blank line when deleting from the middle", () => {
		const deleteFrom = doc.indexOf("world") + 1;
		const result = deleteRange(deleteFrom, deleteFrom + 3);

		expect(result).toBe(`:::transcript[recording.m4a]{start=0 end=2}
Hello :skip{start=0.5 end=1} this is a test.
:::`);
	});

	test("keeps end deletion output unchanged", () => {
		const deleteFrom = doc.indexOf("test.") + 1;
		const result = deleteRange(deleteFrom, deleteFrom + 3);

		expect(result).toBe(`:::transcript[recording.m4a]{start=0 end=1.6}
Hello world this is a
:::`);
	});
});
