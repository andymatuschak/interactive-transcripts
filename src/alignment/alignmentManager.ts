import { App, TFile } from "obsidian";
import { alignmentStore } from "./alignmentStore";
import { SpeechEngineManager, DEFAULT_PARAKEET_MODEL } from "./speechEngine";
import { AlignmentCache } from "./alignmentCache";
import { parseContentWithSkips } from "../core/parser";
import { hashString } from "../core/hash";
import { reconcileAlignmentToText } from "./reconcile";
import { DEFAULT_SETTINGS, type TranscriptPluginSettings } from "../settings";
import type { TranscriptDirective, AlignmentData, AlignedSegment, AlignedWord } from "../types";

export type AlignmentStatus = "idle" | "pending" | "generating" | "complete" | "error";

export interface AlignmentProgress {
	status: AlignmentStatus;
	phase?: "downloading" | "transcribing";
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

	private speechEngine: SpeechEngineManager;
	private cache: AlignmentCache;

	// Status tracking per audio path
	private progress: Map<string, AlignmentProgress> = new Map();
	private statusListeners: Set<StatusListener> = new Set();

	// Queue management
	private queue: AlignmentTask[] = [];
	private currentTask: AlignmentTask | null = null;
	private isProcessing = false;

	// Debounce timers per directive (audioPath + normalized content)
	private debounceTimers: Map<string, NodeJS.Timeout> = new Map();
	private readonly DEBOUNCE_MS = 2000;

	// Generation counter per directive (audioPath + normalized content)
	// to detect stale async requests after content reverts
	private requestGeneration: Map<string, number> = new Map();

	private constructor(
		private app: App,
		pluginDir: string,
		private getSettings: () => TranscriptPluginSettings = () => DEFAULT_SETTINGS
	) {
		this.speechEngine = new SpeechEngineManager(app, pluginDir);
		this.cache = new AlignmentCache(app, pluginDir);
	}


	/**
	 * Initialize the singleton with the app. Must be called once in onload().
	 */
	static initialize(
		app: App,
		pluginDir: string,
		getSettings?: () => TranscriptPluginSettings
	): AlignmentManager {
		if (AlignmentManager.instance) {
			throw new Error("AlignmentManager already initialized");
		}
		AlignmentManager.instance = new AlignmentManager(app, pluginDir, getSettings);
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
		const directiveKey = this.makeDirectiveKey(directive);

		// Increment generation so any in-flight async request for this
		// directive knows it's been superseded (e.g. content reverted)
		const gen = (this.requestGeneration.get(directiveKey) ?? 0) + 1;
		this.requestGeneration.set(directiveKey, gen);

		// Find the audio file
		const audioFile = this.app.vault.getAbstractFileByPath(audioPath);
		if (!(audioFile instanceof TFile)) {
			return;
		}

		// Check in-memory store first (handles in-place updates from editing)
		if (alignmentStore.has(audioPath, directive.content)) {
			this.setProgress(audioPath, { status: "complete" });
			return;
		}

		// Check disk cache (async — a newer request may supersede us)
		const cached = await this.cache.get(audioFile, directive.content);
		if (this.requestGeneration.get(directiveKey) !== gen) return;
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

		// Try a cheap token-diff reconciliation against existing alignment for
		// small edits that do not need acoustic realignment.
		const reconciled = await this.tryReconcileAlignment(directive, audioFile);
		if (reconciled) {
			alignmentStore.set(audioPath, directive.content, reconciled);
			await this.cache.set(audioFile, directive.content, reconciled);
			this.setProgress(audioPath, { status: "complete" });
			return;
		}

		// Clear any existing debounce timer for this directive
		this.clearDebounceTimer(directiveKey);

		// Abort any queued task for this specific directive content
		this.abortTaskForDirective(directive);

		// Set status to pending (debouncing)
		this.setProgress(audioPath, { status: "pending" });

		// Debounce the alignment request
		const timer = setTimeout(() => {
			this.debounceTimers.delete(directiveKey);
			this.enqueueTask(directive, audioFile);
		}, this.DEBOUNCE_MS);

		this.debounceTimers.set(directiveKey, timer);
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
		// Cancel all debounce timers for this audio path
		const prefix = audioPath + "\0";
		for (const [key, timer] of this.debounceTimers) {
			if (key.startsWith(prefix)) {
				clearTimeout(timer);
				this.debounceTimers.delete(key);
			}
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

	/**
	 * Cancel debounce timers whose content no longer matches any current directive.
	 * Called by the loader before requesting alignments so that timers for
	 * reverted or undone edits don't trigger unnecessary alignment generation.
	 */
	cancelStaleTimers(currentDirectives: readonly TranscriptDirective[]): void {
		const currentKeys = new Set(currentDirectives.map(d => this.makeDirectiveKey(d)));
		for (const [key, timer] of this.debounceTimers) {
			if (!currentKeys.has(key)) {
				clearTimeout(timer);
				this.debounceTimers.delete(key);
			}
		}
	}

	private clearDebounceTimer(debounceKey: string): void {
		const timer = this.debounceTimers.get(debounceKey);
		if (timer) {
			clearTimeout(timer);
			this.debounceTimers.delete(debounceKey);
		}
	}

	private makeDirectiveKey(directive: TranscriptDirective): string {
		return `${directive.audioPath}\0${directive.content.replace(/\s+/g, " ").trim()}`;
	}

	/**
	 * Abort any queued task for a specific directive (same audio + content).
	 */
	private abortTaskForDirective(directive: TranscriptDirective): void {
		const key = this.makeDirectiveKey(directive);

		// Abort current task if it matches this directive
		if (this.currentTask && this.makeDirectiveKey(this.currentTask.directive) === key) {
			this.currentTask.abortController.abort();
		}

		// Remove matching tasks from queue
		this.queue = this.queue.filter((task) => {
			if (this.makeDirectiveKey(task.directive) === key) {
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

			this.setProgress(audioPath, { status: "generating", phase: "transcribing", percent: 0 });

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
		onProgress: (phase: "downloading" | "transcribing", percent: number) => void
	): Promise<AlignmentData> {
		const { directive, audioFile, abortController } = task;
		const parsedContent = parseContentWithSkips(directive.content);
		const settings = this.currentSettings();

		const providerType = settings.speechProvider || "local";
		let apiKey = "";
		let model = settings.parakeetModel;

		if (providerType === "openai") {
			apiKey = settings.openAiApiKey;
			model = settings.openAiModel || "whisper-1";
		} else if (providerType === "gemini") {
			apiKey = settings.geminiApiKey;
			model = settings.geminiModel || "gemini-2.0-flash";
		} else if (providerType === "openrouter") {
			apiKey = settings.openRouterApiKey;
			model = settings.openRouterModel || "google/gemini-2.5-flash";
		}

		const parakeetData = await this.speechEngine.transcribe(audioFile, {
			providerType,
			apiKey,
			model,
			modelPath: settings.modelPath,
			start: directive.attributes.start,
			end: directive.attributes.end,
			skips: parsedContent.skips.map((skip) => ({
				start: skip.audioStart,
				end: skip.audioEnd,
			})),
			chunkDuration: settings.parakeetChunkDuration,
			overlapDuration: settings.parakeetOverlapDuration,
			paragraphBreakGap: settings.paragraphBreakGap,
			clampWordEnds: settings.clampWordEnds,
			signal: abortController.signal,
			onProgress: (info) => {
				onProgress(info.phase, info.percent);
			},
		});

		const data = this.projectTranscriptionToDirective(parakeetData, parsedContent.text);
		data.transcriptHash = await hashString(parsedContent.text);

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

		// Shutdown the local speech server
		this.speechEngine.shutdown();
	}

	private currentSettings(): TranscriptPluginSettings {
		const settings = this.getSettings();
		return {
			...DEFAULT_SETTINGS,
			...settings,
			parakeetModel: settings.parakeetModel || DEFAULT_PARAKEET_MODEL,
		};
	}

	/**
	 * Transcribe a standalone audio file and cache the resulting
	 * timestamped transcript.
	 */
	async transcribeAudioFile(
		audioFile: TFile,
		audioPath: string = audioFile.path,
		onProgress?: (progress: AlignmentProgress) => void
	): Promise<AlignmentData> {
		const settings = this.currentSettings();
		const providerType = settings.speechProvider || "local";
		let apiKey = "";
		let model = settings.parakeetModel;

		if (providerType === "openai") {
			apiKey = settings.openAiApiKey;
			model = settings.openAiModel || "whisper-1";
		} else if (providerType === "gemini") {
			apiKey = settings.geminiApiKey;
			model = settings.geminiModel || "gemini-2.0-flash";
		} else if (providerType === "openrouter") {
			apiKey = settings.openRouterApiKey;
			model = settings.openRouterModel || "google/gemini-2.5-flash";
		}

		const data = await this.speechEngine.transcribe(audioFile, {
			providerType,
			apiKey,
			model,
			modelPath: settings.modelPath,
			chunkDuration: settings.parakeetChunkDuration,
			overlapDuration: settings.parakeetOverlapDuration,
			paragraphBreakGap: settings.paragraphBreakGap,
			clampWordEnds: settings.clampWordEnds,
			onProgress: (info) => {
				onProgress?.({ status: "generating", phase: info.phase, percent: info.percent });
			},
		});

		alignmentStore.set(audioPath, data.text, data);
		await this.cache.set(audioFile, data.text, data);
		return data;
	}

	private async tryReconcileAlignment(
		directive: TranscriptDirective,
		audioFile: TFile
	): Promise<AlignmentData | null> {
		const parsedContent = parseContentWithSkips(directive.content);
		const sources = alignmentStore.findByAudioPath(directive.audioPath);

		let best: { alignment: AlignmentData; similarity: number } | null = null;
		for (const source of sources) {
			const result = reconcileAlignmentToText(source, parsedContent.text, 0.65);
			if (!result) continue;
			if (!best || result.similarity > best.similarity) {
				best = result;
			}
		}

		if (!best) return null;

		const alignment = {
			...best.alignment,
			transcriptHash: await hashString(parsedContent.text),
			tool: "parakeet-mlx-reconciled",
			createdAt: Date.now(),
		};

		return alignment;
	}

	private projectTranscriptionToDirective(data: AlignmentData, directiveText: string): AlignmentData {
		const normalizedDataText = data.text.replace(/\s+/g, " ").trim();
		const normalizedDirectiveText = directiveText.replace(/\s+/g, " ").trim();

		if (normalizedDataText === normalizedDirectiveText) {
			return { ...data, text: directiveText };
		}

		const projected = reconcileAlignmentToText(data, directiveText, 0.55);
		if (!projected) {
			throw new Error("Generated transcript is too different from the directive text to project timestamps");
		}

		return {
			...projected.alignment,
			audioHash: data.audioHash,
			language: data.language,
			tool: "parakeet-mlx-projected",
			createdAt: Date.now(),
		};
	}
}
