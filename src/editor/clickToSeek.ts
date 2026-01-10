import { EditorView } from "@codemirror/view";
import { transcriptField } from "./state";
import { alignmentStore } from "../alignment/alignmentStore";
import { AudioManager } from "../playback/audioManager";
import type { TranscriptDirective, AlignedWord } from "../types";

/**
 * Find the word at a given document position within a directive.
 * Returns the word and its index, or null if not found.
 */
function findWordAtPosition(
	directive: TranscriptDirective,
	docPos: number
): { word: AlignedWord; index: number } | null {
	const words = alignmentStore.getWords(directive.audioPath, directive.content);
	if (words.length === 0) return null;

	const content = directive.content;
	const relativePos = docPos - directive.contentFrom;

	if (relativePos < 0 || relativePos > content.length) return null;

	// Walk through words to find which one contains this position
	let charPos = 0;
	for (let i = 0; i < words.length; i++) {
		const word = words[i];
		if (!word) continue;

		const wordText = word.word.trim();
		const idx = content.indexOf(wordText, charPos);

		if (idx === -1) continue;

		const wordStart = idx;
		const wordEnd = idx + wordText.length;

		if (relativePos >= wordStart && relativePos <= wordEnd) {
			return { word, index: i };
		}

		charPos = wordEnd;
	}

	return null;
}

/**
 * Handle Cmd-click (Mac) or Ctrl-click (Windows/Linux) to play from clicked word.
 */
function handleClick(event: MouseEvent, view: EditorView): boolean {
	// Check for Cmd (Mac) or Ctrl (Windows/Linux)
	const isMac = navigator.platform.toLowerCase().includes("mac");
	const modifierPressed = isMac ? event.metaKey : event.ctrlKey;

	if (!modifierPressed) return false;

	// Get document position from click coordinates
	const pos = view.posAtCoords({ x: event.clientX, y: event.clientY });
	if (pos === null) return false;

	// Find if click is within a transcript directive
	const fieldValue = view.state.field(transcriptField, false);
	if (!fieldValue) return false;

	const directive = fieldValue.directives.find(
		(d) => pos >= d.contentFrom && pos <= d.to
	);
	if (!directive) return false;

	// Check if we have alignment data
	if (!alignmentStore.has(directive.audioPath, directive.content)) {
		console.debug("No alignment data for", directive.audioPath);
		return false;
	}

	// Find the word at click position
	const result = findWordAtPosition(directive, pos);
	if (!result) return false;

	// Start playback from this word
	const audioManager = AudioManager.getInstance();
	audioManager.play(directive, result.word.start);

	// Prevent default click behavior and text selection
	event.preventDefault();
	return true;
}

/**
 * Extension that adds Cmd-click handler for seeking to any word.
 */
export const clickToSeekExtension = EditorView.domEventHandlers({
	click: handleClick,
});
