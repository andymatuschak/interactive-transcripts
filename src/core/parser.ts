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
import type { TranscriptDirective, SkipMarker } from "../types";

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
 * Serialize a textDirective node back to its original syntax.
 * Used to preserve :skip{...} markers in content.
 */
function serializeTextDirective(node: RootContent): string {
	const directive = node as { name?: string; attributes?: Record<string, string> };
	if (!directive.name) return "";

	const attrs = directive.attributes;
	if (!attrs || Object.keys(attrs).length === 0) {
		return `:${directive.name}`;
	}

	const attrStr = Object.entries(attrs)
		.map(([k, v]) => `${k}=${v}`)
		.join(" ");
	return `:${directive.name}{${attrStr}}`;
}

/**
 * Extract plain text content from mdast children nodes.
 * Preserves textDirective nodes (like :skip{...}) in their original form.
 */
function extractTextContent(children: RootContent[]): string {
	let text = "";

	for (const child of children) {
		if (child.type === "text") {
			text += child.value;
		} else if (child.type === "textDirective") {
			// Preserve text directives like :skip{start=X end=Y}
			text += serializeTextDirective(child);
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
				// Find where content starts (after opening fence line)
				let contentFrom = position.start.offset ?? 0;
				const firstChild = contentChildren[0];
				if (firstChild?.position?.start?.offset !== undefined) {
					contentFrom = firstChild.position.start.offset;
				} else {
					// Fallback: find first newline after directive start
					const directiveStart = position.start.offset ?? 0;
					const newlinePos = markdown.indexOf("\n", directiveStart);
					if (newlinePos !== -1) {
						contentFrom = newlinePos + 1;
					}
				}

				directives.push({
					audioPath,
					attributes: parseTimeAttributes(
						containerDirective.attributes as Record<string, string | undefined>
					),
					content,
					from: position.start.offset ?? 0,
					to: position.end.offset ?? markdown.length,
					contentFrom,
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

/**
 * Result of parsing content with skip markers.
 */
export interface ParsedContentWithSkips {
	/** Content with :skip{...} markers removed */
	text: string;
	/** Parsed skip markers with their positions in the cleaned text */
	skips: SkipMarker[];
	/** Original content with skip markers intact */
	rawContent: string;
}

/** Regex to match :skip{start=X end=Y} patterns */
const SKIP_REGEX = /:skip\{start=([\d.]+)\s+end=([\d.]+)\}/g;

/**
 * Parse content and extract skip markers.
 *
 * Returns the content with skip markers removed, along with the parsed
 * skip markers. Each skip marker's position refers to where it was in
 * the cleaned text (i.e., where the skipped content would have been).
 */
export function parseContentWithSkips(content: string): ParsedContentWithSkips {
	const skips: SkipMarker[] = [];
	let text = "";
	let lastIndex = 0;
	let removedChars = 0;

	// Reset regex state
	SKIP_REGEX.lastIndex = 0;

	let match;
	while ((match = SKIP_REGEX.exec(content)) !== null) {
		const [fullMatch, startStr, endStr] = match;
		const matchStart = match.index;

		// Add text before this match
		text += content.slice(lastIndex, matchStart);

		// Calculate position in cleaned text
		const positionInCleanedText = matchStart - removedChars;

		skips.push({
			position: positionInCleanedText,
			audioStart: parseFloat(startStr!),
			audioEnd: parseFloat(endStr!),
		});

		// Track how many characters we've removed
		removedChars += fullMatch!.length;
		lastIndex = matchStart + fullMatch!.length;
	}

	// Add remaining text after last match
	text += content.slice(lastIndex);

	return {
		text,
		skips,
		rawContent: content,
	};
}
