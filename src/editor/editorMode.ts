import { StateField, StateEffect } from "@codemirror/state";
import { ViewPlugin, EditorView } from "@codemirror/view";

const setLivePreview = StateEffect.define<boolean>();

/**
 * StateField tracking whether the editor is in live preview mode.
 * In source mode, transcript styling and controls should be disabled.
 * Defaults to true (live preview); corrected on first update and mode switches.
 */
export const livePreviewField = StateField.define<boolean>({
	create: () => true,
	update(value, tr) {
		for (const e of tr.effects) {
			if (e.is(setLivePreview)) return e.value;
		}
		return value;
	},
});

/** Obsidian puts `is-live-preview` on the parent of the CM editor element. */
function checkLivePreview(view: EditorView): boolean {
	return view.dom.parentElement?.classList.contains("is-live-preview") ?? true;
}

/**
 * ViewPlugin that detects Obsidian's live preview vs source mode
 * by watching the `is-live-preview` class on the CM editor's parent.
 */
export const livePreviewDetector = ViewPlugin.define((view) => {
	let current: boolean | null = null;

	const parentEl = view.dom.parentElement;

	const sync = () => {
		const isLP = checkLivePreview(view);
		if (isLP !== current) {
			current = isLP;
			view.dispatch({ effects: setLivePreview.of(isLP) });
		}
	};

	const observer = new MutationObserver(sync);
	if (parentEl) {
		observer.observe(parentEl, { attributes: true, attributeFilter: ["class"] });
	}

	return {
		update() {
			if (current === null) {
				const isLP = checkLivePreview(view);
				current = isLP;
				if (!isLP) {
					requestAnimationFrame(() => {
						view.dispatch({ effects: setLivePreview.of(false) });
					});
				}
			}
		},
		destroy() {
			observer.disconnect();
		},
	};
});
