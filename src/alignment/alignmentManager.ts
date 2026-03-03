import { App, TFile } from "obsidian";
import { alignmentStore } from "./alignmentStore";
import { Aligner } from "./aligner";
import { AlignmentCache } from "./alignmentCache";
import type { TranscriptDirective, AlignmentData, AlignedSegment, AlignedWord } from "../types";

export type AlignmentStatus = "idle" | "pending" | "generating" | "complete" | "error";

export interface AlignmentProgress {
	status: AlignmentStatus;
	phase?: "loading" | "aligning" | "adjusting";
	percent?: number;
}

interface AlignmentTask {
	directive: TranscriptDirective;
	audioFile: TFile;
	abortController: AbortController;
}

type StatusListener = (audioPath: string, progress: AlignmentProgress) => void;

/**
 * Manages alignment generation with queueing, debouncing, and status tracking.
 */
export class AlignmentManager {
	private static instance: AlignmentManager | null = null;

	private aligner: Aligner;
	private cache: AlignmentCache;

	// Status tracking per audio path
	private progress: Map<string, AlignmentProgress> = new Map();
	private statusListeners: Set<StatusListener> = new Set();

	// Queue management
	private queue: AlignmentTask[] = [];
	private currentTask: AlignmentTask | null = null;
	private isProcessing = false;

	// Debounce timers per audio path
	private debounceTimers: Map<string, NodeJS.Timeout> = new Map();
	private readonly DEBOUNCE_MS = 2000;

	private constructor(private app: App) {
		this.aligner = new Aligner(app);
		this.cache = new AlignmentCache(app);
	}

	/**
	 * Initialize the singleton with the app. Must be called once in onload().
	 */
	static initialize(app: App): AlignmentManager {
		if (AlignmentManager.instance) {
			throw new Error("AlignmentManager already initialized");
		}
		AlignmentManager.instance = new AlignmentManager(app);
		return AlignmentManager.instance;
	}

	/**
	 * Get the singleton instance. Throws if not initialized.
	 */
	static getInstance(): AlignmentManager {
		if (!AlignmentManager.instance) {
			throw new Error("AlignmentManager not initialized. Call initialize() in onload() first.");
		}
		return AlignmentManager.instance;
	}

	static destroy(): void {
		if (AlignmentManager.instance) {
			AlignmentManager.instance.cleanup();
			AlignmentManager.instance = null;
		}
	}

	/**
	 * Request alignment for a directive. Will debounce, queue, and auto-generate.
	 */
	async requestAlignment(directive: TranscriptDirective): Promise<void> {
		const audioPath = directive.audioPath;

		// Find the audio file
		const audioFile = this.app.vault.getAbstractFileByPath(audioPath);
		if (!(audioFile instanceof TFile)) {
			console.debug(`Audio file not found: ${audioPath}`);
			return;
		}

		// Check in-memory store first (handles in-place updates from editing)
		if (alignmentStore.has(audioPath, directive.content)) {
			this.setProgress(audioPath, { status: "complete" });
			return;
		}

		// Check disk cache
		const cached = await this.cache.get(audioFile, directive.content);
		if (cached) {
			alignmentStore.set(audioPath, directive.content, cached);
			this.setProgress(audioPath, { status: "complete" });
			return;
		}

		// Try to derive from an existing alignment (e.g. pasted excerpt)
		const derived = this.tryDeriveAlignment(directive);
		if (derived) {
			alignmentStore.set(audioPath, directive.content, derived);
			await this.cache.set(audioFile, directive.content, derived);
			this.setProgress(audioPath, { status: "complete" });
			return;
		}

		// Clear any existing debounce timer
		const existingTimer = this.debounceTimers.get(audioPath);
		if (existingTimer) {
			clearTimeout(existingTimer);
		}

		// Abort any in-progress or queued task for this audio path
		this.abortTaskForPath(audioPath);

		// Set status to pending (debouncing)
		this.setProgress(audioPath, { status: "pending" });

		// Debounce the alignment request
		const timer = setTimeout(() => {
			this.debounceTimers.delete(audioPath);
			this.enqueueTask(directive, audioFile);
		}, this.DEBOUNCE_MS);

		this.debounceTimers.set(audioPath, timer);
	}

	/**
	 * Get the current status for an audio path.
	 */
	getStatus(audioPath: string): AlignmentStatus {
		return this.progress.get(audioPath)?.status || "idle";
	}

	/**
	 * Get the current progress for an audio path.
	 */
	getProgress(audioPath: string): AlignmentProgress {
		return this.progress.get(audioPath) || { status: "idle" };
	}

	/**
	 * Subscribe to status changes.
	 */
	subscribeToStatus(listener: StatusListener): () => void {
		this.statusListeners.add(listener);
		return () => this.statusListeners.delete(listener);
	}

	/**
	 * Abort any pending/in-progress alignment for a path (e.g., on edit).
	 */
	abortTaskForPath(audioPath: string): void {
		// Cancel debounce timer
		const timer = this.debounceTimers.get(audioPath);
		if (timer) {
			clearTimeout(timer);
			this.debounceTimers.delete(audioPath);
		}

		// Abort current task if it matches
		if (this.currentTask?.directive.audioPath === audioPath) {
			this.currentTask.abortController.abort();
			// Don't set status here - let the task handler do it
		}

		// Remove from queue
		this.queue = this.queue.filter((task) => {
			if (task.directive.audioPath === audioPath) {
				task.abortController.abort();
				return false;
			}
			return true;
		});
	}

	private setProgress(audioPath: string, progress: AlignmentProgress): void {
		this.progress.set(audioPath, progress);
		this.statusListeners.forEach((listener) => listener(audioPath, progress));
	}

	/**
	 * Try to derive alignment from an existing alignment for the same audio path.
	 * This handles pasted excerpts that have start/end attributes — we can filter
	 * the source alignment's words by time range instead of re-running the aligner.
	 */
	private tryDeriveAlignment(directive: TranscriptDirective): AlignmentData | null {
		const { start, end } = directive.attributes;
		if (start === undefined || end === undefined) return null;

		const sources = alignmentStore.findByAudioPath(directive.audioPath);
		if (sources.length === 0) return null;

		const EPS = 0.01;

		for (const source of sources) {
			const filteredWords: AlignedWord[] = [];
			for (const segment of source.segments) {
				for (const word of segment.words) {
					if (word.start >= start - EPS && word.end <= end + EPS) {
						filteredWords.push(word);
					}
				}
			}

			if (filteredWords.length === 0) continue;

			// Group words into segments (split on gaps > 1s)
			const segments: AlignedSegment[] = [];
			let currentWords: AlignedWord[] = [filteredWords[0]!];

			for (let i = 1; i < filteredWords.length; i++) {
				const gap = filteredWords[i]!.start - filteredWords[i - 1]!.end;
				if (gap > 1.0) {
					segments.push({
						start: currentWords[0]!.start,
						end: currentWords[currentWords.length - 1]!.end,
						text: currentWords.map((w) => w.word).join(""),
						words: currentWords,
					});
					currentWords = [filteredWords[i]!];
				} else {
					currentWords.push(filteredWords[i]!);
				}
			}
			segments.push({
				start: currentWords[0]!.start,
				end: currentWords[currentWords.length - 1]!.end,
				text: currentWords.map((w) => w.word).join(""),
				words: currentWords,
			});

			return {
				audioHash: source.audioHash,
				transcriptHash: "",
				language: source.language,
				tool: "derived",
				createdAt: Date.now(),
				segments,
				text: directive.content,
			};
		}

		return null;
	}

	private enqueueTask(directive: TranscriptDirective, audioFile: TFile): void {
		const task: AlignmentTask = {
			directive,
			audioFile,
			abortController: new AbortController(),
		};

		this.queue.push(task);
		this.processQueue();
	}

	private async processQueue(): Promise<void> {
		if (this.isProcessing || this.queue.length === 0) {
			return;
		}

		this.isProcessing = true;

		while (this.queue.length > 0) {
			const task = this.queue.shift()!;
			this.currentTask = task;

			const audioPath = task.directive.audioPath;

			// Check if aborted before starting
			if (task.abortController.signal.aborted) {
				continue;
			}

			this.setProgress(audioPath, { status: "generating", phase: "loading", percent: 0 });

			try {
				const data = await this.generateAlignment(task, (phase, percent) => {
					if (!task.abortController.signal.aborted) {
						this.setProgress(audioPath, { status: "generating", phase, percent });
					}
				});

				// Check if aborted during generation
				if (task.abortController.signal.aborted) {
					continue;
				}

				// Store result
				alignmentStore.set(audioPath, task.directive.content, data);
				this.setProgress(audioPath, { status: "complete" });
			} catch (err) {
				if (task.abortController.signal.aborted) {
					// Aborted - don't set error status
					continue;
				}
				console.error(`Alignment failed for ${audioPath}:`, err);
				this.setProgress(audioPath, { status: "error" });
			}
		}

		this.currentTask = null;
		this.isProcessing = false;
	}

	private async generateAlignment(
		task: AlignmentTask,
		onProgress: (phase: "loading" | "aligning" | "adjusting", percent: number) => void
	): Promise<AlignmentData> {
		const { directive, audioFile, abortController } = task;

		const data = await this.aligner.align(audioFile, directive.content, {
			tool: "stable-ts",
			model: "turbo",
			start: directive.attributes.start,
			end: directive.attributes.end,
			signal: abortController.signal,
			onProgress: (info) => {
				onProgress(info.phase, info.percent);
			},
		});

		// Cache the result
		await this.cache.set(audioFile, directive.content, data);

		return data;
	}

	private cleanup(): void {
		// Clear all timers
		this.debounceTimers.forEach((timer) => clearTimeout(timer));
		this.debounceTimers.clear();

		// Abort all tasks
		if (this.currentTask) {
			this.currentTask.abortController.abort();
		}
		this.queue.forEach((task) => task.abortController.abort());
		this.queue = [];

		this.statusListeners.clear();

		// Shutdown the alignment server
		this.aligner.shutdown();
	}
}
