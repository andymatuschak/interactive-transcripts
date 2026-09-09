import { describe, expect, test } from "bun:test";
import { preserveDirectiveSource } from "./directiveHandoff";
import type { TranscriptDirective } from "../types";

function directive(
	audioPath: string,
	from: number,
	sourcePath?: string
): TranscriptDirective {
	return {
		audioPath,
		sourcePath,
		attributes: {},
		content: `block at ${from}`,
		from,
		to: from + 10,
		contentFrom: from + 1,
	};
}

describe("preserveDirectiveSource", () => {
	test("inherits Reading Mode source identity during a block handoff", () => {
		const current = directive("audio.m4a", 0, "Notes/story.md");
		const next = directive("audio.m4a", 20);

		expect(preserveDirectiveSource(current, next)).toEqual({
			...next,
			sourcePath: "Notes/story.md",
		});
	});

	test("keeps an explicitly sourced next directive unchanged", () => {
		const current = directive("audio.m4a", 0, "Notes/story.md");
		const next = directive("audio.m4a", 20, "Notes/other.md");

		expect(preserveDirectiveSource(current, next)).toBe(next);
	});

	test("keeps Live Preview directives source-less", () => {
		const current = directive("audio.m4a", 0);
		const next = directive("audio.m4a", 20);

		expect(preserveDirectiveSource(current, next)).toBe(next);
	});
});
