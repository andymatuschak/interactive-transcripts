import { WidgetType } from "@codemirror/view";
import { setIcon } from "obsidian";
import type { TranscriptDirective } from "../types";

export class PlayButtonWidget extends WidgetType {
	constructor(private directive: TranscriptDirective) {
		super();
	}

	toDOM(): HTMLElement {
		const button = document.createElement("button");
		button.className = "transcript-play-button";
		button.setAttribute("aria-label", "Play");
		setIcon(button, "play");

		button.addEventListener("click", (e) => {
			e.preventDefault();
			e.stopPropagation();
			console.log("Play clicked for:", this.directive.audioPath);
			// Actual playback will be implemented in a later milestone
		});

		return button;
	}

	eq(other: PlayButtonWidget): boolean {
		return (
			this.directive.audioPath === other.directive.audioPath &&
			this.directive.from === other.directive.from
		);
	}

	ignoreEvent(): boolean {
		return false; // Allow click events
	}
}
