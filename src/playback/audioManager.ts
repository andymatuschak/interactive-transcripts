import { App, Notice, TFile } from "obsidian";
import type { TranscriptDirective } from "../types";

export interface PlaybackState {
	isPlaying: boolean;
	currentTime: number;
	duration: number;
	directive: TranscriptDirective | null;
}

type PlaybackListener = (state: PlaybackState) => void;

/**
 * Singleton manager for audio playback across the vault.
 */
export class AudioManager {
	private static instance: AudioManager | null = null;

	private audio: HTMLAudioElement | null = null;
	private currentDirective: TranscriptDirective | null = null;
	private listeners: Set<PlaybackListener> = new Set();

	private constructor(private app: App) {}

	/**
	 * Initialize the singleton with the app. Must be called once in onload().
	 */
	static initialize(app: App): AudioManager {
		if (AudioManager.instance) {
			throw new Error("AudioManager already initialized");
		}
		AudioManager.instance = new AudioManager(app);
		return AudioManager.instance;
	}

	/**
	 * Get the singleton instance. Throws if not initialized.
	 */
	static getInstance(): AudioManager {
		if (!AudioManager.instance) {
			throw new Error("AudioManager not initialized. Call initialize() in onload() first.");
		}
		return AudioManager.instance;
	}

	static destroy(): void {
		if (AudioManager.instance) {
			AudioManager.instance.stop();
			AudioManager.instance = null;
		}
	}

	/**
	 * Play audio for a transcript directive.
	 */
	async play(
		directive: TranscriptDirective,
		startTime?: number
	): Promise<void> {
		// Stop any current playback
		this.stop();

		// Resolve audio file path to a URL
		const audioUrl = await this.resolveAudioUrl(directive.audioPath);
		if (!audioUrl) {
			new Notice(`Audio file not found: ${directive.audioPath}`);
			return;
		}

		// Create new audio element
		this.audio = new Audio(audioUrl);
		this.currentDirective = directive;

		// Set start time
		const effectiveStart = startTime ?? directive.attributes.start ?? 0;
		this.audio.currentTime = effectiveStart;

		// Set up event listeners
		this.audio.addEventListener("timeupdate", this.handleTimeUpdate);
		this.audio.addEventListener("ended", this.handleEnded);
		this.audio.addEventListener("loadedmetadata", () => {
			this.notifyListeners();
		});

		// Start playback
		try {
			await this.audio.play();
			this.notifyListeners();
		} catch (err) {
			new Notice(`Playback failed: ${directive.audioPath}`);
			this.stop();
		}
	}

	/**
	 * Pause playback.
	 */
	pause(): void {
		this.audio?.pause();
		this.notifyListeners();
	}

	/**
	 * Resume playback.
	 */
	resume(): void {
		this.audio?.play();
		this.notifyListeners();
	}

	/**
	 * Toggle play/pause.
	 */
	togglePlayPause(): void {
		if (this.audio?.paused) {
			this.resume();
		} else {
			this.pause();
		}
	}

	/**
	 * Stop playback and clean up.
	 */
	stop(): void {
		if (this.audio) {
			this.audio.pause();
			this.audio.removeEventListener("timeupdate", this.handleTimeUpdate);
			this.audio.removeEventListener("ended", this.handleEnded);
			this.audio.src = "";
			this.audio = null;
		}
		this.currentDirective = null;
		this.notifyListeners();
	}

	/**
	 * Seek to a specific time.
	 */
	seekTo(time: number): void {
		if (this.audio) {
			this.audio.currentTime = time;
			this.notifyListeners();
		}
	}

	/**
	 * Get current playback state.
	 */
	getState(): PlaybackState {
		return {
			isPlaying: this.audio ? !this.audio.paused : false,
			currentTime: this.audio?.currentTime ?? 0,
			duration: this.audio?.duration ?? 0,
			directive: this.currentDirective,
		};
	}

	/**
	 * Check if a specific directive is currently playing.
	 */
	isPlayingDirective(directive: TranscriptDirective): boolean {
		return (
			this.currentDirective !== null &&
			this.currentDirective.from === directive.from &&
			this.audio !== null &&
			!this.audio.paused
		);
	}

	/**
	 * Subscribe to playback state changes.
	 */
	subscribe(listener: PlaybackListener): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	private handleTimeUpdate = (): void => {
		// Check if we've reached the end time
		const endTime = this.currentDirective?.attributes.end;
		if (
			endTime !== undefined &&
			this.audio &&
			this.audio.currentTime >= endTime
		) {
			this.stop();
			return;
		}
		this.notifyListeners();
	};

	private handleEnded = (): void => {
		this.stop();
	};

	private notifyListeners(): void {
		const state = this.getState();
		this.listeners.forEach((listener) => listener(state));
	}

	/**
	 * Resolve a vault-relative audio path to a playable URL.
	 */
	private async resolveAudioUrl(audioPath: string): Promise<string | null> {
		// Try to find the file in the vault
		const file = this.app.vault.getAbstractFileByPath(audioPath);

		if (file instanceof TFile) {
			return this.app.vault.getResourcePath(file);
		}

		return null;
	}
}
