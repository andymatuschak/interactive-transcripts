import { ViewPlugin, ViewUpdate, Decoration, DecorationSet, EditorView } from "@codemirror/view";
import { AudioManager } from "./audioManager";
import { alignmentStore } from "../alignment/alignmentStore";
import { transcriptField } from "../editor/state";
import type { TranscriptDirective } from "../types";

/**
 * Find the document position for a word (or gap) at a given time.
 * Uses rawContent (from the document) for position calculations because
 * directive.content is AST-reconstructed and doesn't preserve original whitespace.
 */
function findWordPosition(
	directive: TranscriptDirective,
	time: number,
	rawContent: string
): { from: number; to: number } | null {
	const words = alignmentStore.getWords(directive.audioPath, directive.content);
	if (words.length === 0) return null;

	const content = rawContent;

	// Helper to find word position in content
	const getWordDocPosition = (wordIndex: number): { from: number; to: number; charEnd: number } | null => {
		let charPos = 0;
		for (let i = 0; i < wordIndex && i < words.length; i++) {
			const w = words[i];
			if (!w) continue;
			const wordText = w.word.trim();
			const idx = content.indexOf(wordText, charPos);
			if (idx !== -1) {
				charPos = idx + wordText.length;
			}
		}

		const targetWordObj = words[wordIndex];
		if (!targetWordObj) return null;

		const targetWord = targetWordObj.word.trim();
		const targetIdx = content.indexOf(targetWord, charPos);
		if (targetIdx === -1) return null;

		const docFrom = directive.contentFrom + targetIdx;
		const docTo = docFrom + targetWord.length;
		return { from: docFrom, to: docTo, charEnd: targetIdx + targetWord.length };
	};

	// Find the current word or the gap we're in
	let currentWordIndex = -1;
	let prevWordIndex = -1;
	let nextWordIndex = -1;

	for (let i = 0; i < words.length; i++) {
		const word = words[i];
		if (!word) continue;

		if (time >= word.start && time <= word.end) {
			currentWordIndex = i;
			break;
		}

		if (time > word.end) {
			prevWordIndex = i;
		}

		if (time < word.start && nextWordIndex === -1) {
			nextWordIndex = i;
		}
	}

	// If we're on a word, highlight it
	if (currentWordIndex !== -1) {
		const pos = getWordDocPosition(currentWordIndex);
		return pos ? { from: pos.from, to: pos.to } : null;
	}

	// We're in a gap between words
	if (prevWordIndex === -1) {
		// Before the first word - no highlight
		return null;
	}

	const prevWord = words[prevWordIndex];
	const nextWord = nextWordIndex !== -1 ? words[nextWordIndex] : null;

	if (!prevWord) return null;

	// Calculate gap duration
	const gapDuration = nextWord ? nextWord.start - prevWord.end : 0;

	if (gapDuration < 1 || !nextWord) {
		// Gap < 1 second: keep previous word highlighted
		const pos = getWordDocPosition(prevWordIndex);
		return pos ? { from: pos.from, to: pos.to } : null;
	}

	// Gap >= 1 second: highlight the space between words
	const prevPos = getWordDocPosition(prevWordIndex);
	const nextPos = getWordDocPosition(nextWordIndex);

	if (!prevPos || !nextPos) return null;

	// Highlight from end of previous word to start of next word (the space)
	return { from: prevPos.to, to: nextPos.from };
}

/**
 * ViewPlugin that syncs word highlighting with audio playback.
 */
export const highlightSyncPlugin = ViewPlugin.fromClass(
	class {
		decorations: DecorationSet = Decoration.none;
		private unsubscribe: (() => void) | null = null;
		private unsubscribeFinder: (() => void) | null = null;
		private animationFrameId: number | null = null;
		private lastHighlightPos: { from: number; to: number } | null = null;

		constructor(private view: EditorView) {
			const audioManager = AudioManager.getInstance();

			// Animation loop for smooth updates
			const tick = () => {
				this.updateHighlight();
				this.animationFrameId = requestAnimationFrame(tick);
			};

			// Subscribe to playback state changes
			this.unsubscribe = audioManager.subscribe((state) => {
				if (state.isPlaying && this.animationFrameId === null) {
					tick();
				} else if (!state.isPlaying && this.animationFrameId !== null) {
					cancelAnimationFrame(this.animationFrameId);
					this.animationFrameId = null;
					// Clear highlight
					this.clearHighlight();
				}
			});

			// Enable chaining playback across split transcript blocks.
			// Each editor view registers its own finder; AudioManager tries
			// all registered finders so switching files doesn't break chaining.
			this.unsubscribeFinder = audioManager.addNextDirectiveFinder((current) => {
				const fieldValue = this.view.state.field(transcriptField, false);
				if (!fieldValue) return null;
				const sameAudio = fieldValue.directives.filter(
					(d) => d.audioPath === current.audioPath
				);
				const idx = sameAudio.findIndex(
					(d) => d.content === current.content
				);
				if (idx === -1 || idx >= sameAudio.length - 1) return null;
				return sameAudio[idx + 1];
			});
		}

		updateHighlight() {
			if (!this.view.dom.parentElement?.classList.contains("is-live-preview")) {
				this.clearHighlight();
				return;
			}

			const audioManager = AudioManager.getInstance();
			const state = audioManager.getState();

			if (!state.directive || !state.isPlaying) {
				this.clearHighlight();
				return;
			}

			// Find the directive in current document that matches the playing audio
			const fieldValue = this.view.state.field(transcriptField, false);
			if (!fieldValue) return;

			// Find the directive that matches the currently playing audio.
			// Note: state.directive has the original positions from when playback started,
			// but the document may have changed. We look up by audioPath to find the
			// current directive positions.
			const directive = fieldValue.directives.find(
				(d) => d.audioPath === state.directive!.audioPath &&
				       d.content === state.directive!.content
			);
			if (!directive) return;

			// Check if we have alignment data
			if (!alignmentStore.has(directive.audioPath, directive.content)) {
				return;
			}

			// Use raw document text for position calculations
			const rawContent = this.view.state.doc.sliceString(directive.contentFrom, directive.to - 3);
			const pos = findWordPosition(directive, state.currentTime, rawContent);

			if (pos) {
				// Only update if position changed
				if (
					!this.lastHighlightPos ||
					this.lastHighlightPos.from !== pos.from
				) {
					this.decorations = Decoration.set([
						Decoration.mark({
							class: "transcript-word-highlight",
						}).range(pos.from, pos.to),
					]);

					this.lastHighlightPos = pos;

					// Trigger CodeMirror to re-render decorations
					// Empty dispatch forces update cycle to re-read decorations
					this.view.dispatch({});

					// Scroll follow
					this.scrollIntoView(pos.from);
				}
			} else if (this.lastHighlightPos) {
				this.decorations = Decoration.none;
				this.lastHighlightPos = null;
				this.view.dispatch({});
			}
		}

		/**
		 * Scroll the editor to ensure the given position is visible.
		 */
		private scrollIntoView(pos: number) {
			// Use requestMeasure for safe DOM measurement and scrolling
			this.view.requestMeasure({
				read: () => {
					const coords = this.view.coordsAtPos(pos);
					if (!coords) return null;

					const scrollDOM = this.view.scrollDOM;
					const scrollRect = scrollDOM.getBoundingClientRect();

					// Check if position is outside visible area with some margin
					const margin = 50;
					const isAbove = coords.top < scrollRect.top + margin;
					const isBelow = coords.bottom > scrollRect.bottom - margin;

					if (isAbove || isBelow) {
						return { coords, scrollRect, isAbove };
					}
					return null;
				},
				write: (measurement) => {
					if (!measurement) return;

					const { coords, scrollRect, isAbove } = measurement;
					const scrollDOM = this.view.scrollDOM;

					if (isAbove) {
						// Scroll up - position word near top with margin
						const targetScroll =
							scrollDOM.scrollTop -
							(scrollRect.top - coords.top) -
							100;
						scrollDOM.scrollTo({
							top: Math.max(0, targetScroll),
							behavior: "smooth",
						});
					} else {
						// Scroll down - position word near bottom with margin
						const targetScroll =
							scrollDOM.scrollTop +
							(coords.bottom - scrollRect.bottom) +
							100;
						scrollDOM.scrollTo({
							top: targetScroll,
							behavior: "smooth",
						});
					}
				},
			});
		}

		clearHighlight() {
			if (this.decorations !== Decoration.none) {
				this.decorations = Decoration.none;
				this.lastHighlightPos = null;
				this.view.dispatch({});
			}
		}

		update(update: ViewUpdate) {
			// Rebuild decorations if document changed
			if (update.docChanged) {
				this.updateHighlight();
			}
		}

		destroy() {
			this.unsubscribe?.();
			this.unsubscribeFinder?.();
			if (this.animationFrameId !== null) {
				cancelAnimationFrame(this.animationFrameId);
			}
		}
	},
	{
		decorations: (v) => v.decorations,
	}
);
