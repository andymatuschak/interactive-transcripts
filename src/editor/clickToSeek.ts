import {
	Decoration,
	type DecorationSet,
	EditorView,
	ViewPlugin,
	type ViewUpdate,
} from "@codemirror/view";
import { transcriptField } from "./state";
import { alignmentStore } from "../alignment/alignmentStore";
import { AudioManager } from "../playback/audioManager";
import type { TranscriptDirective, AlignedWord } from "../types";

interface TranscriptWordAtPosition {
	directive: TranscriptDirective;
	word: AlignedWord;
	index: number;
	from: number;
	to: number;
}

function isMacPlatform(): boolean {
	return navigator.platform.toLowerCase().includes("mac");
}

function isSeekModifierPressed(event: MouseEvent): boolean {
	return isMacPlatform() ? event.metaKey : event.ctrlKey;
}

function isLivePreview(view: EditorView): boolean {
	return view.dom.parentElement?.classList.contains("is-live-preview") ?? false;
}

/**
 * Find the word at a given document position within a directive.
 * Uses rawContent (from the document) for position calculations because
 * directive.content is AST-reconstructed and doesn't preserve original whitespace.
 */
function findWordAtPosition(
	directive: TranscriptDirective,
	docPos: number,
	rawContent: string
): Omit<TranscriptWordAtPosition, "directive"> | null {
	const words = alignmentStore.getWords(directive.audioPath, directive.content);
	if (words.length === 0) return null;

	const relativePos = docPos - directive.contentFrom;
	if (relativePos < 0 || relativePos > rawContent.length) return null;

	// Walk through words to find which one contains this position.
	let charPos = 0;
	for (let i = 0; i < words.length; i++) {
		const word = words[i];
		if (!word) continue;

		const wordText = word.word.trim();
		const idx = rawContent.indexOf(wordText, charPos);
		if (idx === -1) continue;

		const wordStart = idx;
		const wordEnd = idx + wordText.length;
		if (relativePos >= wordStart && relativePos <= wordEnd) {
			return {
				word,
				index: i,
				from: directive.contentFrom + wordStart,
				to: directive.contentFrom + wordEnd,
			};
		}

		charPos = wordEnd;
	}

	return null;
}

function findTranscriptWordAtPosition(
	view: EditorView,
	docPos: number
): TranscriptWordAtPosition | null {
	const fieldValue = view.state.field(transcriptField, false);
	if (!fieldValue) return null;

	const directive = fieldValue.directives.find(
		(d) => docPos >= d.contentFrom && docPos <= d.to
	);
	if (!directive) return null;

	if (!alignmentStore.has(directive.audioPath, directive.content)) return null;

	const rawContent = view.state.doc.sliceString(
		directive.contentFrom,
		directive.to - 3
	);
	const result = findWordAtPosition(directive, docPos, rawContent);
	return result ? { directive, ...result } : null;
}

/**
 * Handle Cmd-click (Mac) or Ctrl-click (Windows/Linux) to play from clicked word.
 */
function handleClick(event: MouseEvent, view: EditorView): boolean {
	if (!isLivePreview(view) || !isSeekModifierPressed(event)) return false;

	const pos = view.posAtCoords({ x: event.clientX, y: event.clientY });
	if (pos === null) return false;

	const result = findTranscriptWordAtPosition(view, pos);
	if (!result) return false;

	AudioManager.getInstance().play(result.directive, result.word.start);

	// Prevent default click behavior and text selection.
	event.preventDefault();
	return true;
}

interface Point {
	x: number;
	y: number;
}

interface Range {
	from: number;
	to: number;
}

/**
 * Shows the word Cmd-click/Ctrl-click would seek to while the modifier is held.
 */
const commandHoverPlugin = ViewPlugin.fromClass(
	class {
		decorations: DecorationSet = Decoration.none;
		private pointer: Point | null = null;
		private highlightedRange: Range | null = null;
		private modifierPressed = false;

		constructor(private readonly view: EditorView) {
			view.contentDOM.addEventListener("mousemove", this.handleMouseMove);
			view.contentDOM.addEventListener("mouseleave", this.handleMouseLeave);
			window.addEventListener("keydown", this.handleKeyDown);
			window.addEventListener("keyup", this.handleKeyUp);
			window.addEventListener("blur", this.handleWindowBlur);
		}

		update(update: ViewUpdate): void {
			if (update.docChanged || update.viewportChanged) {
				this.refreshHighlight(false);
			}
		}

		destroy(): void {
			this.view.contentDOM.removeEventListener("mousemove", this.handleMouseMove);
			this.view.contentDOM.removeEventListener("mouseleave", this.handleMouseLeave);
			window.removeEventListener("keydown", this.handleKeyDown);
			window.removeEventListener("keyup", this.handleKeyUp);
			window.removeEventListener("blur", this.handleWindowBlur);
		}

		private readonly handleMouseMove = (event: MouseEvent): void => {
			this.pointer = { x: event.clientX, y: event.clientY };
			this.modifierPressed = isSeekModifierPressed(event);
			this.refreshHighlight();
		};

		private readonly handleMouseLeave = (): void => {
			this.pointer = null;
			this.setHighlight(null);
		};

		private readonly handleKeyDown = (event: KeyboardEvent): void => {
			const modifierKey = isMacPlatform() ? "Meta" : "Control";
			if (event.key !== modifierKey) return;

			this.modifierPressed = true;
			this.refreshHighlight();
		};

		private readonly handleKeyUp = (event: KeyboardEvent): void => {
			const modifierKey = isMacPlatform() ? "Meta" : "Control";
			if (event.key !== modifierKey) return;

			this.modifierPressed = false;
			this.setHighlight(null);
		};

		private readonly handleWindowBlur = (): void => {
			this.modifierPressed = false;
			this.setHighlight(null);
		};

		private refreshHighlight(dispatch = true): void {
			if (!this.modifierPressed || !this.pointer || !isLivePreview(this.view)) {
				this.setHighlight(null, dispatch);
				return;
			}

			const pos = this.view.posAtCoords(this.pointer);
			const result =
				pos === null ? null : findTranscriptWordAtPosition(this.view, pos);
			this.setHighlight(
				result ? { from: result.from, to: result.to } : null,
				dispatch
			);
		}

		private setHighlight(range: Range | null, dispatch = true): void {
			const unchanged = this.highlightedRange
				? range !== null &&
					this.highlightedRange.from === range.from &&
					this.highlightedRange.to === range.to
				: range === null;
			if (unchanged) return;

			this.highlightedRange = range;
			this.decorations = range
				? Decoration.set([
						Decoration.mark({ class: "transcript-command-hover" }).range(
							range.from,
							range.to
						),
					])
				: Decoration.none;

			if (dispatch) this.view.dispatch({});
		}
	},
	{
		decorations: (plugin) => plugin.decorations,
	}
);

/**
 * Extension that adds Cmd-click/Ctrl-click seeking and its hover affordance.
 */
export const clickToSeekExtension = [
	EditorView.domEventHandlers({ click: handleClick }),
	commandHoverPlugin,
];
