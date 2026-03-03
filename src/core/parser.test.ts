import { describe, expect, test } from "bun:test";
import { parseTranscriptDirectives, parseContentWithSkips } from "./parser";

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

describe("parseContentWithSkips", () => {
	test("returns content unchanged when no skips", () => {
		const result = parseContentWithSkips("Hello world this is a test.");

		expect(result.text).toBe("Hello world this is a test.");
		expect(result.skips).toHaveLength(0);
		expect(result.rawContent).toBe("Hello world this is a test.");
	});

	test("parses single skip marker", () => {
		const content = "Hello :skip{start=0.5 end=1.5} world.";
		const result = parseContentWithSkips(content);

		expect(result.text).toBe("Hello  world.");
		expect(result.skips).toHaveLength(1);
		expect(result.skips[0]?.position).toBe(6); // After "Hello "
		expect(result.skips[0]?.audioStart).toBe(0.5);
		expect(result.skips[0]?.audioEnd).toBe(1.5);
		expect(result.rawContent).toBe(content);
	});

	test("parses multiple skip markers", () => {
		const content = "Hello :skip{start=0.5 end=1.0} world :skip{start=2.0 end=3.0} test.";
		const result = parseContentWithSkips(content);

		expect(result.text).toBe("Hello  world  test.");
		expect(result.skips).toHaveLength(2);

		// First skip
		expect(result.skips[0]?.position).toBe(6); // After "Hello "
		expect(result.skips[0]?.audioStart).toBe(0.5);
		expect(result.skips[0]?.audioEnd).toBe(1.0);

		// Second skip - position in cleaned text
		expect(result.skips[1]?.position).toBe(13); // "Hello  world " (after first skip removed)
		expect(result.skips[1]?.audioStart).toBe(2.0);
		expect(result.skips[1]?.audioEnd).toBe(3.0);
	});

	test("handles skip at start of content", () => {
		const content = ":skip{start=0 end=2.5}Hello world.";
		const result = parseContentWithSkips(content);

		expect(result.text).toBe("Hello world.");
		expect(result.skips).toHaveLength(1);
		expect(result.skips[0]?.position).toBe(0);
		expect(result.skips[0]?.audioStart).toBe(0);
		expect(result.skips[0]?.audioEnd).toBe(2.5);
	});

	test("handles skip at end of content", () => {
		const content = "Hello world.:skip{start=5.0 end=10.0}";
		const result = parseContentWithSkips(content);

		expect(result.text).toBe("Hello world.");
		expect(result.skips).toHaveLength(1);
		expect(result.skips[0]?.position).toBe(12); // After "Hello world."
		expect(result.skips[0]?.audioStart).toBe(5.0);
		expect(result.skips[0]?.audioEnd).toBe(10.0);
	});

	test("handles floating point timestamps with multiple decimal places", () => {
		const content = "Test :skip{start=1.234 end=5.678} content.";
		const result = parseContentWithSkips(content);

		expect(result.skips[0]?.audioStart).toBe(1.234);
		expect(result.skips[0]?.audioEnd).toBe(5.678);
	});

	test("handles integer timestamps", () => {
		const content = "Test :skip{start=5 end=10} content.";
		const result = parseContentWithSkips(content);

		expect(result.skips[0]?.audioStart).toBe(5);
		expect(result.skips[0]?.audioEnd).toBe(10);
	});

	test("position calculation is correct after multiple skips", () => {
		// Verify that positions in cleaned text are accurate
		const content = "A:skip{start=1 end=2}B:skip{start=3 end=4}C:skip{start=5 end=6}D";
		const result = parseContentWithSkips(content);

		expect(result.text).toBe("ABCD");
		expect(result.skips).toHaveLength(3);

		// Each skip's position should be where it appears in the cleaned text
		expect(result.skips[0]?.position).toBe(1); // After "A"
		expect(result.skips[1]?.position).toBe(2); // After "AB"
		expect(result.skips[2]?.position).toBe(3); // After "ABC"
	});
});
