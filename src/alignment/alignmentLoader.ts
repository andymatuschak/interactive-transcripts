import { App } from "obsidian";
import { ViewPlugin, ViewUpdate, EditorView } from "@codemirror/view";
import { transcriptField } from "../editor/state";
import { AlignmentManager } from "./alignmentManager";

/**
 * Initialize the alignment manager with the app.
 * Must be called in plugin.onload() before registerEditorExtension().
 */
export function initAlignmentLoader(app: App): void {
	AlignmentManager.initialize(app);
}

/**
 * ViewPlugin that automatically loads/generates alignment data for transcripts.
 */
export const alignmentLoaderPlugin = ViewPlugin.define((view) => {
	// Load alignments for any directives in the document
	loadAlignments(view);

	return {
		update(update: ViewUpdate) {
			// Reload if document changed (content might have changed)
			if (update.docChanged) {
				loadAlignments(update.view);
			}
		},
		destroy() {
			// Nothing to clean up
		},
	};
});

/**
 * Request alignments for all directives in the view.
 */
function loadAlignments(view: EditorView): void {
	const manager = AlignmentManager.getInstance();
	const fieldValue = view.state.field(transcriptField, false);
	if (!fieldValue) return;

	// Cancel debounce timers for content that no longer exists in the
	// document (e.g. edits that were undone or backspaced away)
	manager.cancelStaleTimers(fieldValue.directives);

	for (const directive of fieldValue.directives) {
		manager.requestAlignment(directive);
	}
}
