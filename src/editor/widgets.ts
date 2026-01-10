import { WidgetType } from "@codemirror/view";
import { setIcon } from "obsidian";
import { AudioManager } from "../playback/audioManager";
import { AlignmentManager, AlignmentProgress } from "../alignment/alignmentManager";
import type { TranscriptDirective } from "../types";

/**
 * Create an SVG radial progress indicator.
 */
function createRadialProgress(percent: number): SVGElement {
	const size = 12;
	const strokeWidth = 2;
	const radius = (size - strokeWidth) / 2;
	const circumference = 2 * Math.PI * radius;
	const offset = circumference - (percent / 100) * circumference;

	const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
	svg.setAttribute("width", String(size));
	svg.setAttribute("height", String(size));
	svg.setAttribute("viewBox", `0 0 ${size} ${size}`);
	svg.classList.add("transcript-radial-progress");

	// Background circle
	const bgCircle = document.createElementNS("http://www.w3.org/2000/svg", "circle");
	bgCircle.setAttribute("cx", String(size / 2));
	bgCircle.setAttribute("cy", String(size / 2));
	bgCircle.setAttribute("r", String(radius));
	bgCircle.setAttribute("fill", "none");
	bgCircle.setAttribute("stroke", "currentColor");
	bgCircle.setAttribute("stroke-width", String(strokeWidth));
	bgCircle.setAttribute("opacity", "0.3");
	svg.appendChild(bgCircle);

	// Progress circle
	const progressCircle = document.createElementNS("http://www.w3.org/2000/svg", "circle");
	progressCircle.setAttribute("cx", String(size / 2));
	progressCircle.setAttribute("cy", String(size / 2));
	progressCircle.setAttribute("r", String(radius));
	progressCircle.setAttribute("fill", "none");
	progressCircle.setAttribute("stroke", "currentColor");
	progressCircle.setAttribute("stroke-width", String(strokeWidth));
	progressCircle.setAttribute("stroke-linecap", "round");
	progressCircle.setAttribute("stroke-dasharray", String(circumference));
	progressCircle.setAttribute("stroke-dashoffset", String(offset));
	progressCircle.setAttribute("transform", `rotate(-90 ${size / 2} ${size / 2})`);
	svg.appendChild(progressCircle);

	return svg;
}

export class PlayButtonWidget extends WidgetType {
	private audioUnsubscribe: (() => void) | null = null;
	private alignmentUnsubscribe: (() => void) | null = null;

	constructor(private directive: TranscriptDirective) {
		super();
	}

	toDOM(): HTMLElement {
		const button = document.createElement("button");
		button.className = "transcript-play-button";
		button.setAttribute("aria-label", "Play");

		const audioManager = AudioManager.getInstance();
		const alignmentManager = AlignmentManager.getInstance();

		let currentProgress: AlignmentProgress = { status: "idle" };

		const updateIcon = () => {
			button.empty();

			// Show radial progress if alignment is pending or generating
			if (currentProgress.status === "pending" || currentProgress.status === "generating") {
				const percent = currentProgress.percent ?? 0;
				const svg = createRadialProgress(percent);
				button.appendChild(svg);
				button.addClass("transcript-generating");
				const phase = currentProgress.phase || "loading";
				button.setAttribute("aria-label", `${phase}: ${percent}%`);
				return;
			}

			button.removeClass("transcript-generating");

			if (audioManager.isPlayingDirective(this.directive)) {
				setIcon(button, "pause");
				button.setAttribute("aria-label", "Pause");
			} else {
				setIcon(button, "play");
				button.setAttribute("aria-label", "Play");
			}
		};

		// Get initial alignment progress
		currentProgress = alignmentManager.getProgress(this.directive.audioPath);

		updateIcon();

		// Subscribe to audio state changes
		this.audioUnsubscribe = audioManager.subscribe(() => {
			updateIcon();
		});

		// Subscribe to alignment progress changes
		this.alignmentUnsubscribe = alignmentManager.subscribeToStatus((audioPath, progress) => {
			if (audioPath === this.directive.audioPath) {
				currentProgress = progress;
				updateIcon();
			}
		});

		button.addEventListener("pointerdown", (e) => {
			e.preventDefault();
			e.stopPropagation();
		});

		button.addEventListener("click", (e) => {
			e.preventDefault();
			e.stopPropagation();

			// Don't allow click while alignment is loading
			if (currentProgress.status === "pending" || currentProgress.status === "generating") {
				return;
			}

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
		this.audioUnsubscribe?.();
		this.audioUnsubscribe = null;
		this.alignmentUnsubscribe?.();
		this.alignmentUnsubscribe = null;
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
