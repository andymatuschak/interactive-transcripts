import { ViewPlugin, ViewUpdate, EditorView } from "@codemirror/view";
import { setIcon } from "obsidian";
import { AudioManager, PlaybackState } from "./audioManager";
import { transcriptField } from "../editor/state";

/**
 * Floating playback controls as a CodeMirror ViewPlugin.
 */
export const floatingControlsPlugin = ViewPlugin.define((view) => {
	const audioManager = AudioManager.getInstance();
	let isDragging = false;

	// Create container
	const container = document.createElement("div");
	container.className = "transcript-floating-controls";

	// Play/Pause button
	const playPauseBtn = document.createElement("button");
	playPauseBtn.className = "transcript-control-btn transcript-play-pause";
	playPauseBtn.setAttribute("aria-label", "Play/Pause");
	setIcon(playPauseBtn, "play");
	playPauseBtn.addEventListener("click", () => audioManager.togglePlayPause());
	container.appendChild(playPauseBtn);

	// Current time display
	const currentTimeDisplay = document.createElement("span");
	currentTimeDisplay.className = "transcript-time-display";
	currentTimeDisplay.textContent = "0:00";
	container.appendChild(currentTimeDisplay);

	// Scrubber
	const scrubber = document.createElement("input");
	scrubber.type = "range";
	scrubber.className = "transcript-scrubber";
	scrubber.min = "0";
	scrubber.max = "1000";
	scrubber.value = "0";

	scrubber.addEventListener("input", () => {
		isDragging = true;
		const state = audioManager.getState();
		const time = (parseFloat(scrubber.value) / 1000) * state.duration;
		audioManager.seekTo(time);
		const percent = (parseFloat(scrubber.value) / 1000) * 100;
		scrubber.style.background = `linear-gradient(to right, var(--interactive-accent) ${percent}%, var(--background-modifier-border) ${percent}%)`;
	});

	scrubber.addEventListener("change", () => {
		isDragging = false;
	});

	container.appendChild(scrubber);

	// Duration display
	const durationDisplay = document.createElement("span");
	durationDisplay.className = "transcript-time-display";
	durationDisplay.textContent = "0:00";
	container.appendChild(durationDisplay);

	// Close button
	const closeBtn = document.createElement("button");
	closeBtn.className = "transcript-control-btn transcript-close";
	closeBtn.setAttribute("aria-label", "Stop");
	setIcon(closeBtn, "x");
	closeBtn.addEventListener("click", () => audioManager.stop());
	container.appendChild(closeBtn);

	// Append to editor
	view.dom.appendChild(container);

	// Format time helper
	const formatTime = (seconds: number): string => {
		if (isNaN(seconds) || !isFinite(seconds)) return "0:00";
		const mins = Math.floor(seconds / 60);
		const secs = Math.floor(seconds % 60);
		return `${mins}:${secs.toString().padStart(2, "0")}`;
	};

	// Update UI based on playback state
	const updateUI = (state: PlaybackState) => {
		if (state.directive) {
			container.classList.add("is-visible");
		} else {
			container.classList.remove("is-visible");
			return;
		}

		// Update play/pause icon
		playPauseBtn.empty();
		setIcon(playPauseBtn, state.isPlaying ? "pause" : "play");

		// Update scrubber
		if (!isDragging && state.duration > 0) {
			const progress = (state.currentTime / state.duration) * 1000;
			scrubber.value = String(progress);
		}

		// Update scrubber fill color
		const percent = state.duration > 0 ? (state.currentTime / state.duration) * 100 : 0;
		scrubber.style.background = `linear-gradient(to right, var(--interactive-accent) ${percent}%, var(--background-modifier-border) ${percent}%)`;

		// Update time displays
		currentTimeDisplay.textContent = formatTime(state.currentTime);
		durationDisplay.textContent = formatTime(state.duration);
	};

	// Subscribe to audio state changes
	const unsubscribe = audioManager.subscribe(updateUI);

	// Initial state
	updateUI(audioManager.getState());

	return {
		update(update: ViewUpdate) {
			// If document changed and audio is playing, check if the directive still exists
			const playbackState = audioManager.getState();
			if (playbackState.directive && update.docChanged) {
				const fieldValue = update.state.field(transcriptField, false);
				if (fieldValue) {
					const stillExists = fieldValue.directives.some(
						d => d.audioPath === playbackState.directive!.audioPath
					);
					if (!stillExists) {
						audioManager.stop();
					}
				} else {
					audioManager.stop();
				}
			}
		},
		destroy() {
			// Stop playback when this editor is destroyed (e.g., file navigation)
			audioManager.stop();
			unsubscribe();
			container.remove();
		}
	};
});
