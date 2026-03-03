import {
	ViewPlugin,
	ViewUpdate,
	EditorView,
	Decoration,
	DecorationSet,
} from "@codemirror/view";
import { Range } from "@codemirror/state";
import { transcriptField } from "./state";
import { PlayButtonWidget, SkipWidget } from "./widgets";
import { AlignmentManager } from "../alignment/alignmentManager";

/** Regex to match :skip{start=X end=Y} patterns in document text */
const SKIP_REGEX = /:skip\{start=([\d.]+)\s+end=([\d.]+)\}/g;

function buildDecorations(view: EditorView, aligningPaths: Set<string>): DecorationSet {
	const decorations: Range<Decoration>[] = [];
	const { directives } = view.state.field(transcriptField);
	const cursorPos = view.state.selection.main.head;

	for (const directive of directives) {
		const startLine = view.state.doc.lineAt(directive.from);
		const endLine = view.state.doc.lineAt(directive.to);
		const isActive = cursorPos >= directive.from && cursorPos <= directive.to;
		const isAligning = aligningPaths.has(directive.audioPath);
		const activeClass = isActive ? " transcript-active" : "";
		const aligningClass = isAligning ? " transcript-aligning" : "";

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
					class: `transcript-content-line${isFirstContent ? " transcript-first-content" : ""}${activeClass}${aligningClass}`,
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

			// Find and replace :skip{...} markers with SkipWidget
			const lineText = line.text;
			SKIP_REGEX.lastIndex = 0;
			let match;
			while ((match = SKIP_REGEX.exec(lineText)) !== null) {
				const audioStart = parseFloat(match[1]!);
				const audioEnd = parseFloat(match[2]!);
				const from = line.from + match.index;
				const to = from + match[0].length;

				decorations.push(
					Decoration.replace({
						widget: new SkipWidget(audioStart, audioEnd),
					}).range(from, to)
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
		private aligningPaths: Set<string> = new Set();
		private unsubscribe: (() => void) | null = null;

		constructor(private view: EditorView) {
			this.decorations = buildDecorations(view, this.aligningPaths);
			this.subscribeToAlignmentStatus();
		}

		private rebuildDecorations() {
			this.decorations = buildDecorations(this.view, this.aligningPaths);
			this.view.dispatch({});
		}

		private subscribeToAlignmentStatus() {
			const manager = AlignmentManager.getInstance();

			this.unsubscribe = manager.subscribeToStatus((audioPath, progress) => {
				const wasAligning = this.aligningPaths.has(audioPath);
				const isAligning = progress.status === "pending" || progress.status === "generating";

				if (isAligning !== wasAligning) {
					if (isAligning) {
						this.aligningPaths.add(audioPath);
					} else {
						this.aligningPaths.delete(audioPath);
					}
					this.rebuildDecorations();
				}
			});
		}

		update(update: ViewUpdate) {
			if (update.docChanged || update.viewportChanged || update.selectionSet) {
				this.decorations = buildDecorations(update.view, this.aligningPaths);
			}
		}

		destroy() {
			this.unsubscribe?.();
		}
	},
	{
		decorations: (v) => v.decorations,
	}
);
