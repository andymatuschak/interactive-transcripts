import { Plugin } from "obsidian";
import { EditorView } from "@codemirror/view";
import { transcriptField } from "./editor/state";

export default class TranscriptPlugin extends Plugin {
	async onload(): Promise<void> {
		console.debug("Transcript plugin loaded");

		// Register CodeMirror extension for parsing transcript directives
		this.registerEditorExtension([transcriptField]);

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
		console.debug("Transcript plugin unloaded");
	}
}
