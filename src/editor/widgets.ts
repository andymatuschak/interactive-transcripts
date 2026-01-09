import { WidgetType } from "@codemirror/view";
import { setIcon } from "obsidian";
import { AudioManager } from "../playback/audioManager";
import type { TranscriptDirective } from "../types";

export class PlayButtonWidget extends WidgetType {
	private unsubscribe: (() => void) | null = null;

	constructor(private directive: TranscriptDirective) {
		super();
	}

	toDOM(): HTMLElement {
		const button = document.createElement("button");
		button.className = "transcript-play-button";
		button.setAttribute("aria-label", "Play");

		const audioManager = AudioManager.getInstance();
		const updateIcon = () => {
			button.empty();
			if (audioManager.isPlayingDirective(this.directive)) {
				setIcon(button, "pause");
			} else {
				setIcon(button, "play");
			}
		};

		updateIcon();

		// Subscribe to state changes to update icon
		this.unsubscribe = audioManager.subscribe(() => {
			updateIcon();
		});

		button.addEventListener("pointerdown", (e) => {
			e.preventDefault();
			e.stopPropagation();
		});

		button.addEventListener("click", (e) => {
			e.preventDefault();
			e.stopPropagation();

			const state = audioManager.getState();

			// If this directive is currently active, toggle play/pause
			if (state.directive?.from === this.directive.from) {
				audioManager.togglePlayPause();
			} else {
				// Play this directive from the start
				audioManager.play(this.directive);
			}
		});

		return button;
	}

	destroy(): void {
		this.unsubscribe?.();
		this.unsubscribe = null;
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
