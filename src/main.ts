import { Plugin } from "obsidian";
import { EditorView } from "@codemirror/view";
import { transcriptField } from "./editor/state";
import { wordHighlightField } from "./editor/highlightState";
import { transcriptViewPlugin } from "./editor/viewPlugin";
import { clickToSeekExtension } from "./editor/clickToSeek";
import { copyHandlerExtension } from "./editor/copyHandler";
import { AudioManager } from "./playback/audioManager";
import { floatingControlsPlugin } from "./playback/floatingControls";
import { highlightSyncPlugin } from "./playback/highlightSync";
import { initAlignmentLoader, alignmentLoaderPlugin } from "./alignment/alignmentLoader";
import { AlignmentManager } from "./alignment/alignmentManager";

export default class TranscriptPlugin extends Plugin {
	async onload(): Promise<void> {
		console.debug("Transcript plugin loaded");

		// Initialize singletons
		AudioManager.initialize(this.app);
		initAlignmentLoader(this.app);

		// Register CodeMirror extensions
		this.registerEditorExtension([
			transcriptField,
			wordHighlightField,
			transcriptViewPlugin,
			clickToSeekExtension,
			copyHandlerExtension,
			alignmentLoaderPlugin,
			floatingControlsPlugin,
			highlightSyncPlugin,
		]);

		// Debug command to test parsing
		this.addCommand({
			id: "debug-parse-transcripts",
			name: "Debug: Log parsed transcripts",
			editorCallback: (editor, view) => {
				// @ts-expect-error, not typed
				const editorView = view.editor.cm as EditorView;
				const fieldValue = editorView.state.field(transcriptField);
				console.log("Parsed directives:", fieldValue.directives);
			},
		});
	}

	onunload(): void {
		AudioManager.destroy();
		AlignmentManager.destroy();
		console.debug("Transcript plugin unloaded");
	}
}
