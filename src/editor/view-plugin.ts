import {
	ViewPlugin,
	ViewUpdate,
	EditorView,
	Decoration,
	DecorationSet,
} from "@codemirror/view";
import { Range } from "@codemirror/state";
import { transcriptField } from "./state";
import { PlayButtonWidget } from "./widgets";

function buildDecorations(view: EditorView): DecorationSet {
	const decorations: Range<Decoration>[] = [];
	const { directives } = view.state.field(transcriptField);
	const cursorPos = view.state.selection.main.head;

	for (const directive of directives) {
		const startLine = view.state.doc.lineAt(directive.from);
		const endLine = view.state.doc.lineAt(directive.to);
		const isActive = cursorPos >= directive.from && cursorPos <= directive.to;
		const activeClass = isActive ? " transcript-active" : "";

		// Style the opening fence line
		decorations.push(
			Decoration.line({
				class: `transcript-fence-line transcript-start${activeClass}`,
			}).range(startLine.from)
		);

		// Style content lines
		const firstContentLineNum = startLine.number + 1;
		for (
			let lineNum = firstContentLineNum;
			lineNum < endLine.number;
			lineNum++
		) {
			const line = view.state.doc.line(lineNum);
			const isFirstContent = lineNum === firstContentLineNum;
			decorations.push(
				Decoration.line({
					class: `transcript-content-line${isFirstContent ? " transcript-first-content" : ""}${activeClass}`,
				}).range(line.from)
			);

			// Add play button widget on the first content line
			if (isFirstContent) {
				decorations.push(
					Decoration.widget({
						widget: new PlayButtonWidget(directive),
						side: -1,
					}).range(line.from)
				);
			}
		}

		// Style the closing fence line
		decorations.push(
			Decoration.line({
				class: `transcript-fence-line${activeClass}`,
			}).range(endLine.from)
		);
	}

	// Sort decorations by position (required by CodeMirror)
	decorations.sort((a, b) => a.from - b.from);

	return Decoration.set(decorations);
}

export const transcriptViewPlugin = ViewPlugin.fromClass(
	class {
		decorations: DecorationSet;

		constructor(view: EditorView) {
			this.decorations = buildDecorations(view);
		}

		update(update: ViewUpdate) {
			if (
				update.docChanged ||
				update.viewportChanged ||
				update.selectionSet
			) {
				this.decorations = buildDecorations(update.view);
			}
		}
	},
	{
		decorations: (v) => v.decorations,
	}
);
