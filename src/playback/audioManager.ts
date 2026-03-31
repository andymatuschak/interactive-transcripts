import { App, Notice, TFile } from "obsidian";
import type { SkipMarker, TranscriptDirective } from "../types";
import { parseContentWithSkips } from "../core/parser";

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
	private skipRegions: SkipMarker[] = [];
	private listeners: Set<PlaybackListener> = new Set();
	private nextDirectiveFinders: Set<
		(current: TranscriptDirective) => TranscriptDirective | null
	> = new Set();

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
			AudioManager.instance.nextDirectiveFinders.clear();
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

		// Parse skip regions from directive content
		const { skips } = parseContentWithSkips(directive.content);
		this.skipRegions = skips;

		// Set start time, adjusting if it falls within a skip region
		let effectiveStart = startTime ?? directive.attributes.start ?? 0;
		for (const skip of this.skipRegions) {
			if (effectiveStart >= skip.audioStart && effectiveStart < skip.audioEnd) {
				effectiveStart = skip.audioEnd;
				break;
			}
		}
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
		this.skipRegions = [];
		this.notifyListeners();
	}

	/**
	 * Seek to a specific time. If the time is within a skip region,
	 * seeks to the end of that skip region instead.
	 */
	seekTo(time: number): void {
		if (this.audio) {
			// Check if seeking into a skip region
			let targetTime = time;
			for (const skip of this.skipRegions) {
				if (time >= skip.audioStart && time < skip.audioEnd) {
					targetTime = skip.audioEnd;
					break;
				}
			}
			this.audio.currentTime = targetTime;
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

	/**
	 * Register a callback that finds the next directive to chain playback to.
	 * Multiple finders can be registered (one per editor view); the first
	 * non-null result wins. Returns an unsubscribe function.
	 */
	addNextDirectiveFinder(
		finder: (current: TranscriptDirective) => TranscriptDirective | null
	): () => void {
		this.nextDirectiveFinders.add(finder);
		return () => this.nextDirectiveFinders.delete(finder);
	}

	/**
	 * Advance playback to the next directive without restarting the audio element.
	 */
	private advanceToDirective(next: TranscriptDirective): void {
		this.currentDirective = next;

		const { skips } = parseContentWithSkips(next.content);
		this.skipRegions = skips;

		let effectiveStart = next.attributes.start ?? 0;
		for (const skip of this.skipRegions) {
			if (effectiveStart >= skip.audioStart && effectiveStart < skip.audioEnd) {
				effectiveStart = skip.audioEnd;
				break;
			}
		}

		if (this.audio) {
			this.audio.currentTime = effectiveStart;
		}
		this.notifyListeners();
	}

	private handleTimeUpdate = (): void => {
		if (!this.audio) return;

		const currentTime = this.audio.currentTime;

		// Check if we've entered a skip region - if so, jump past it
		for (const skip of this.skipRegions) {
			if (currentTime >= skip.audioStart && currentTime < skip.audioEnd) {
				this.audio.currentTime = skip.audioEnd;
				// Don't notify yet - the next timeupdate will handle it
				return;
			}
		}

		// Check if we've reached the end time
		const endTime = this.currentDirective?.attributes.end;
		if (endTime !== undefined && currentTime >= endTime) {
			if (this.currentDirective) {
				for (const finder of this.nextDirectiveFinders) {
					const next = finder(this.currentDirective);
					if (next) {
						this.advanceToDirective(next);
						return;
					}
				}
			}
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
