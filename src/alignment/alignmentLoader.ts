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

	for (const directive of fieldValue.directives) {
		// Request alignment (will use cache if available, debounce if needed)
		manager.requestAlignment(directive);
	}
}
