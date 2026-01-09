import { StateField, EditorState } from "@codemirror/state";
import type { TranscriptDirective } from "../types";
import { parseTranscriptDirectives } from "../core/parser";

export interface TranscriptFieldValue {
	directives: TranscriptDirective[];
}

export const transcriptField = StateField.define<TranscriptFieldValue>({
	create(state: EditorState): TranscriptFieldValue {
		const markdown = state.doc.toString();
		return {
			directives: parseTranscriptDirectives(markdown),
		};
	},

	update(value, transaction): TranscriptFieldValue {
		if (!transaction.docChanged) {
			return value;
		}
		const markdown = transaction.state.doc.toString();
		return {
			directives: parseTranscriptDirectives(markdown),
		};
	},
});
