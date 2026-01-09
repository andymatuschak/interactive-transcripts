import { describe, expect, test } from "bun:test";
import { parseTranscriptDirectives } from "./parser";

describe("parseTranscriptDirectives", () => {
	test("parses a basic transcript directive", () => {
		const markdown = `# Test

:::transcript[audio.m4a]
This is the transcript content.
:::
`;
		const result = parseTranscriptDirectives(markdown);

		expect(result).toHaveLength(1);
		expect(result[0]?.audioPath).toBe("audio.m4a");
		expect(result[0]?.content).toBe("This is the transcript content.");
		expect(result[0]?.attributes).toEqual({});
	});

	test("parses transcript with start/end attributes", () => {
		const markdown = `:::transcript[recording.m4a]{start=5.5 end=120.25}
Hello world.
:::`;
		const result = parseTranscriptDirectives(markdown);

		expect(result).toHaveLength(1);
		expect(result[0]?.audioPath).toBe("recording.m4a");
		expect(result[0]?.attributes.start).toBe(5.5);
		expect(result[0]?.attributes.end).toBe(120.25);
	});

	test("parses multiple transcript directives", () => {
		const markdown = `:::transcript[first.m4a]
First transcript.
:::

Some text in between.

:::transcript[second.m4a]
Second transcript.
:::`;
		const result = parseTranscriptDirectives(markdown);

		expect(result).toHaveLength(2);
		expect(result[0]?.audioPath).toBe("first.m4a");
		expect(result[1]?.audioPath).toBe("second.m4a");
	});

	test("ignores directives inside code blocks", () => {
		const markdown = `# Documentation

Here's how to use the transcript syntax:

\`\`\`markdown
:::transcript[example.m4a]
This should NOT be parsed as a directive.
:::
\`\`\`

And here's a real one:

:::transcript[real.m4a]
This SHOULD be parsed.
:::`;
		const result = parseTranscriptDirectives(markdown);

		expect(result).toHaveLength(1);
		expect(result[0]?.audioPath).toBe("real.m4a");
		expect(result[0]?.content).toBe("This SHOULD be parsed.");
	});

	test("ignores directives inside inline code", () => {
		const markdown = `You can use \`:::transcript[file.m4a]\` to create a transcript.

:::transcript[actual.m4a]
Real content.
:::`;
		const result = parseTranscriptDirectives(markdown);

		expect(result).toHaveLength(1);
		expect(result[0]?.audioPath).toBe("actual.m4a");
	});

	test("handles multi-line content", () => {
		const markdown = `:::transcript[audio.m4a]
Line one.
Line two.
Line three.
:::`;
		const result = parseTranscriptDirectives(markdown);

		expect(result).toHaveLength(1);
		expect(result[0]?.content).toContain("Line one.");
		expect(result[0]?.content).toContain("Line two.");
		expect(result[0]?.content).toContain("Line three.");
	});

	test("returns correct positions", () => {
		const markdown = `:::transcript[audio.m4a]
Content.
:::`;
		const result = parseTranscriptDirectives(markdown);

		expect(result).toHaveLength(1);
		expect(result[0]?.from).toBe(0);
		expect(result[0]?.to).toBe(markdown.length);
	});

	test("ignores non-transcript directives", () => {
		const markdown = `:::note
This is a note, not a transcript.
:::

:::transcript[audio.m4a]
This is a transcript.
:::

:::warning
This is a warning.
:::`;
		const result = parseTranscriptDirectives(markdown);

		expect(result).toHaveLength(1);
		expect(result[0]?.audioPath).toBe("audio.m4a");
	});

	test("handles empty content", () => {
		const markdown = `:::transcript[audio.m4a]
:::`;
		const result = parseTranscriptDirectives(markdown);

		expect(result).toHaveLength(1);
		expect(result[0]?.content).toBe("");
	});

	test("handles file paths with spaces", () => {
		const markdown = `:::transcript[my audio file.m4a]
Content here.
:::`;
		const result = parseTranscriptDirectives(markdown);

		expect(result).toHaveLength(1);
		expect(result[0]?.audioPath).toBe("my audio file.m4a");
	});

	test("handles file paths with subdirectories", () => {
		const markdown = `:::transcript[recordings/2024/interview.m4a]
Content here.
:::`;
		const result = parseTranscriptDirectives(markdown);

		expect(result).toHaveLength(1);
		expect(result[0]?.audioPath).toBe("recordings/2024/interview.m4a");
	});
});
