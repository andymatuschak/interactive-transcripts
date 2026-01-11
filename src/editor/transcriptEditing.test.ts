import { describe, expect, test } from "bun:test";
import { EditorState } from "@codemirror/state";
import { findDeletion, findTextReplacement } from "./transcriptEditing";

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
