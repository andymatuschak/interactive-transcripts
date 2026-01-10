import { StateField, StateEffect } from "@codemirror/state";

/**
 * Represents the currently highlighted word position in the document.
 */
export interface WordHighlight {
	/** Start position in document */
	from: number;
	/** End position in document */
	to: number;
}

/**
 * Effect to update the current word highlight.
 */
export const setWordHighlight = StateEffect.define<WordHighlight | null>();

/**
 * State field tracking the currently highlighted word during playback.
 */
export const wordHighlightField = StateField.define<WordHighlight | null>({
	create() {
		return null;
	},

	update(value, transaction) {
		for (const effect of transaction.effects) {
			if (effect.is(setWordHighlight)) {
				return effect.value;
			}
		}
		return value;
	},
});
