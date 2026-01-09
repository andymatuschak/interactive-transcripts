/**
 * Parser for transcript directives using micromark/mdast.
 *
 * This properly handles markdown structure, so directives inside
 * code blocks or comments are correctly ignored.
 */

import { fromMarkdown } from "mdast-util-from-markdown";
import { directive } from "micromark-extension-directive";
import { directiveFromMarkdown } from "mdast-util-directive";
import type { Paragraph, Root, RootContent } from "mdast";
import type { ContainerDirective } from "mdast-util-directive";
import type { TranscriptDirective } from "../types";

/**
 * Parse time attributes from directive attributes.
 * Handles both numeric values and string values.
 */
function parseTimeAttributes(attrs: Record<string, string | undefined> | undefined): {
	start?: number;
	end?: number;
} {
	if (!attrs) return {};

	const result: { start?: number; end?: number } = {};

	if (attrs.start !== undefined) {
		const num = parseFloat(attrs.start);
		if (!isNaN(num)) result.start = num;
	}

	if (attrs.end !== undefined) {
		const num = parseFloat(attrs.end);
		if (!isNaN(num)) result.end = num;
	}

	return result;
}

/**
 * Extract plain text content from mdast children nodes.
 */
function extractTextContent(children: RootContent[]): string {
	let text = "";

	for (const child of children) {
		if (child.type === "text") {
			text += child.value;
		} else if (child.type === "paragraph") {
			if ("children" in child) {
				text += extractTextContent(child.children as RootContent[]);
			}
			text += "\n";
		} else if ("children" in child && Array.isArray(child.children)) {
			text += extractTextContent(child.children as RootContent[]);
		} else if ("value" in child && typeof child.value === "string") {
			text += child.value;
		}
	}

	return text.trim();
}

/**
 * Check if a node is a transcript container directive.
 */
function isTranscriptDirective(node: RootContent): node is ContainerDirective {
	return node.type === "containerDirective" && (node as ContainerDirective).name === "transcript";
}

/**
 * Parse all transcript directives from a markdown string.
 *
 * Uses micromark with the directive extension to properly parse markdown,
 * so directives inside code blocks or HTML comments are ignored.
 */
export function parseTranscriptDirectives(markdown: string): TranscriptDirective[] {
	const tree: Root = fromMarkdown(markdown, {
		extensions: [directive()],
		mdastExtensions: [directiveFromMarkdown()],
	});

	const directives: TranscriptDirective[] = [];

	for (const node of tree.children) {
		if (isTranscriptDirective(node)) {
			const containerDirective = node as ContainerDirective;

			// Extract audio path from label and separate content children
			let audioPath = "";
			const contentChildren: RootContent[] = [];

			for (const child of containerDirective.children) {
				if (child.type === "paragraph" && (child as Paragraph).data?.directiveLabel) {
					audioPath = extractTextContent([child]);
				} else {
					contentChildren.push(child);
				}
			}

			const content = extractTextContent(contentChildren);
			const position = containerDirective.position;

			if (audioPath && position) {
				directives.push({
					audioPath,
					attributes: parseTimeAttributes(
						containerDirective.attributes as Record<string, string | undefined>
					),
					content,
					from: position.start.offset ?? 0,
					to: position.end.offset ?? markdown.length,
				});
			}
		}
	}

	return directives;
}

/**
 * Parse a single transcript directive from text.
 * Useful for parsing clipboard content or reading view.
 */
export function parseTranscriptFromText(text: string): TranscriptDirective | null {
	const directives = parseTranscriptDirectives(text);
	return directives[0] ?? null;
}
