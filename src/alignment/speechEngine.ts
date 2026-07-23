import { ChildProcess, spawn } from "child_process";
import * as fs from "fs";
import { App, ButtonComponent, FileSystemAdapter, Modal, TFile } from "obsidian";
import * as path from "path";
import { hashFile, hashString } from "../core/hash";
import type { AlignmentData } from "../types";

export const DEFAULT_PARAKEET_MODEL = "mlx-community/parakeet-tdt-0.6b-v3";
const DEFAULT_MODEL_SIZE_BYTES = 2_508_288_736;
const UV_DOCS_URL = "https://docs.astral.sh/uv/";
const UV_REQUIRED_MESSAGE = "Transcription requires uv, a Python package manager. Install it, then restart Obsidian.";
const FFMPEG_DOCS_URL = "https://ffmpeg.org/download.html";
const FFMPEG_REQUIRED_MESSAGE = "Transcription requires ffmpeg to read audio files. Install it, then restart Obsidian.";
const PYTHON_RUNTIME_MISSING_MESSAGE = "This installation is missing the bundled Python transcription runtime. Reinstall from the full release archive.";

let uvRequiredModalOpen = false;
let ffmpegRequiredModalOpen = false;
let modelDownloadPrompt: Promise<boolean> | null = null;

import type { ITranscriptionProvider, SpeechEngineOptions, SpeechProgressInfo } from "./provider";
export type { SpeechEngineOptions, SpeechProgressInfo } from "./provider";
export type SpeechPhase = "downloading" | "transcribing";

interface SpeechRequest {
	action: "transcribe";
	audio: string;
	model: string;
	modelPath?: string;
	allowModelDownload?: boolean;
	start?: number;
	end?: number;
	skips?: Array<{ start: number; end: number }>;
	chunkDuration?: number;
	overlapDuration?: number;
	paragraphBreakGap?: number;
	clampWordEnds?: boolean;
}

interface SpeechResponse {
	status: "ok" | "error" | "shutdown";
	result?: AlignmentData;
	message?: string;
	code?: string;
	modelSizeBytes?: number;
}

export class UvNotFoundError extends Error {
	constructor() {
		super(UV_REQUIRED_MESSAGE);
		this.name = "UvNotFoundError";
	}
}

export class FfmpegNotFoundError extends Error {
	constructor() {
		super(FFMPEG_REQUIRED_MESSAGE);
		this.name = "FfmpegNotFoundError";
	}
}

export class ModelDownloadCancelledError extends Error {
	constructor() {
		super("Model download cancelled");
		this.name = "ModelDownloadCancelledError";
	}
}

export class PythonRuntimeMissingError extends Error {
	constructor(missingPath: string) {
		super(`${PYTHON_RUNTIME_MISSING_MESSAGE} Missing: ${missingPath}`);
		this.name = "PythonRuntimeMissingError";
	}
}

class DependencyRequiredModal extends Modal {
	constructor(
		app: App,
		private title: string,
		private message: string,
		private installUrl: string,
		private onDismiss: () => void
	) {
		super(app);
	}

	onOpen(): void {
		const { contentEl } = this;
		this.setTitle(this.title);
		contentEl.empty();
		contentEl.createEl("p", { text: this.message });

		const buttonContainer = contentEl.createDiv({ cls: "modal-button-container" });
		new ButtonComponent(buttonContainer)
			.setButtonText("Install")
			.setCta()
			.onClick(() => {
				this.close();
				openUrl(this.installUrl);
			});
		new ButtonComponent(buttonContainer)
			.setButtonText("Cancel")
			.onClick(() => {
				this.close();
			});
	}

	onClose(): void {
		this.onDismiss();
		this.contentEl.empty();
	}
}

class ModelDownloadRequiredModal extends Modal {
	private settled = false;

	constructor(
		app: App,
		private sizeBytes: number,
		private resolveChoice: (download: boolean) => void
	) {
		super(app);
	}

	onOpen(): void {
		const { contentEl } = this;
		this.setTitle("Download local model");
		contentEl.empty();
		contentEl.createEl("p", {
			text: `Transcription requires a ${formatGigabytes(this.sizeBytes)} download for the local model.`,
		});

		const buttonContainer = contentEl.createDiv({ cls: "modal-button-container" });
		new ButtonComponent(buttonContainer)
			.setButtonText("Download")
			.setCta()
			.onClick(() => {
				this.finish(true);
			});
		new ButtonComponent(buttonContainer)
			.setButtonText("Cancel")
			.onClick(() => {
				this.finish(false);
			});
	}

	onClose(): void {
		if (!this.settled) {
			this.resolveChoice(false);
			this.settled = true;
		}
		this.contentEl.empty();
	}

	private finish(download: boolean): void {
		if (this.settled) return;
		this.settled = true;
		this.resolveChoice(download);
		this.close();
	}
}

function openUrl(url: string): void {
	window.open(url);
}

function showUvRequiredModal(app: App): void {
	if (uvRequiredModalOpen) return;
	uvRequiredModalOpen = true;
	new DependencyRequiredModal(app, "uv required", UV_REQUIRED_MESSAGE, UV_DOCS_URL, () => {
		uvRequiredModalOpen = false;
	}).open();
}

function showFfmpegRequiredModal(app: App): void {
	if (ffmpegRequiredModalOpen) return;
	ffmpegRequiredModalOpen = true;
	new DependencyRequiredModal(app, "ffmpeg required", FFMPEG_REQUIRED_MESSAGE, FFMPEG_DOCS_URL, () => {
		ffmpegRequiredModalOpen = false;
	}).open();
}

function requestModelDownload(app: App, sizeBytes: number): Promise<boolean> {
	if (modelDownloadPrompt) return modelDownloadPrompt;

	modelDownloadPrompt = new Promise<boolean>((resolve) => {
		new ModelDownloadRequiredModal(app, sizeBytes, resolve).open();
	}).finally(() => {
		modelDownloadPrompt = null;
	});

	return modelDownloadPrompt;
}

function formatGigabytes(bytes: number): string {
	return `${(bytes / 1_000_000_000).toFixed(1)}GB`;
}

function isExecutableFile(candidate: string): boolean {
	try {
		const stat = fs.statSync(candidate);
		if (!stat.isFile()) return false;
		if (process.platform === "win32") return true;
		fs.accessSync(candidate, fs.constants.X_OK);
		return true;
	} catch {
		return false;
	}
}

function findExecutable(name: string, extraCandidates: string[] = []): string | null {
	for (const p of extraCandidates) {
		if (isExecutableFile(p)) return p;
	}

	for (const dir of (process.env.PATH || "").split(path.delimiter)) {
		if (!dir) continue;
		const executableName = process.platform === "win32" ? `${name}.exe` : name;
		const candidate = path.join(dir, executableName);
		if (isExecutableFile(candidate)) return candidate;
	}

	return null;
}

function findUvPath(): string | null {
	const home = process.env.HOME;
	return findExecutable("uv", [
		"/opt/homebrew/bin/uv",
		"/usr/local/bin/uv",
		...(home ? [
			path.join(home, ".cargo", "bin", "uv"),
			path.join(home, ".local", "bin", "uv"),
		] : []),
	]);
}

function findFfmpegPath(): string | null {
	return findExecutable("ffmpeg", [
		"/opt/homebrew/bin/ffmpeg",
		"/usr/local/bin/ffmpeg",
	]);
}

function expandHome(p: string): string {
	if (p === "~") return process.env.HOME || p;
	if (p.startsWith(`~${path.sep}`) || p.startsWith("~/")) {
		return path.join(process.env.HOME || "", p.slice(2));
	}
	return p;
}

function validateModelPath(modelPath?: string): string | undefined {
	const trimmed = modelPath?.trim();
	if (!trimmed) return undefined;

	const expanded = path.resolve(expandHome(trimmed));
	if (!fs.existsSync(expanded) || !fs.statSync(expanded).isDirectory()) {
		throw new Error("Model path must be a folder");
	}
	if (!fs.existsSync(path.join(expanded, "config.json")) || !fs.existsSync(path.join(expanded, "model.safetensors"))) {
		throw new Error("Model path must contain config.json and model.safetensors");
	}

	return expanded;
}

function parseProgressOutput(message: string): SpeechProgressInfo | null {
	const downloadMatch = message.match(/Downloading model:\s*(\d+)%/);
	if (downloadMatch?.[1]) {
		return { phase: "downloading", percent: parseInt(downloadMatch[1], 10) };
	}

	const transcribeMatch = message.match(/Transcribing:\s*(\d+)%/);
	if (transcribeMatch?.[1]) {
		return { phase: "transcribing", percent: parseInt(transcribeMatch[1], 10) };
	}

	if (message.includes("Post-processing")) {
		return { phase: "transcribing", percent: 95 };
	}

	if (
		message.includes("Initializing") ||
		message.includes("Server ready") ||
		message.includes("Loading") ||
		message.includes("Preparing")
	) {
		return { phase: "transcribing", percent: 0 };
	}

	return null;
}

/**
 * Persistent local speech engine backed by Parakeet MLX.
 */
export class LocalParakeetEngine implements ITranscriptionProvider {
	readonly id = "local";
	readonly name = "Local Parakeet-MLX";

	private serverProcess: ChildProcess | null = null;
	private serverReady = false;
	private idleTimer: NodeJS.Timeout | null = null;
	private requestLock: Promise<unknown> = Promise.resolve();
	private pendingResponse: {
		resolve: (data: SpeechResponse) => void;
		reject: (err: Error) => void;
		onProgress?: (info: SpeechProgressInfo) => void;
	} | null = null;
	private responseBuffer = "";

	private readonly IDLE_TIMEOUT_MS = 10 * 60 * 1000;
	private readonly STARTUP_TIMEOUT_MS = 180 * 1000;

	constructor(private app: App, private pluginDir: string) {}

	private getServerScriptPath(): string {
		const adapter = this.app.vault.adapter;
		if (!(adapter instanceof FileSystemAdapter)) {
			throw new Error("Local transcription requires a file system adapter");
		}
		const basePath = adapter.getBasePath();
		return path.join(basePath, this.pluginDir, "python", "speechServer.py");
	}

	private getPythonDir(): string {
		return path.dirname(this.getServerScriptPath());
	}

	private validatePythonRuntime(): void {
		for (const requiredPath of [
			this.getServerScriptPath(),
			path.join(this.getPythonDir(), "pyproject.toml"),
			path.join(this.getPythonDir(), "uv.lock"),
		]) {
			if (!fs.existsSync(requiredPath) || !fs.statSync(requiredPath).isFile()) {
				throw new PythonRuntimeMissingError(requiredPath);
			}
		}
	}

	private async ensureServer(onProgress?: (info: SpeechProgressInfo) => void): Promise<void> {
		if (this.serverProcess && this.serverReady) {
			this.resetIdleTimer();
			return;
		}

		if (this.serverProcess) {
			this.serverProcess.kill();
			this.serverProcess = null;
		}
		this.responseBuffer = "";

		this.validatePythonRuntime();

		const uvPath = findUvPath();
		if (!uvPath) {
			showUvRequiredModal(this.app);
			throw new UvNotFoundError();
		}
		if (!findFfmpegPath()) {
			showFfmpegRequiredModal(this.app);
			throw new FfmpegNotFoundError();
		}

		const scriptPath = this.getServerScriptPath();
		const pythonDir = this.getPythonDir();
		const extraPaths = ["/opt/homebrew/bin", "/usr/local/bin"];
		const currentPath = process.env.PATH || "";
		const augmentedPath = [...extraPaths, currentPath].join(":");

		return new Promise((resolve, reject) => {
			let startupTimer: NodeJS.Timeout | null = null;
			let startupSettled = false;
			const clearStartupTimer = () => {
				if (startupTimer) {
					clearTimeout(startupTimer);
					startupTimer = null;
				}
			};

			this.serverProcess = spawn(
				uvPath,
				["run", "--project", pythonDir, "python", scriptPath],
				{
					stdio: ["pipe", "pipe", "pipe"],
					env: { ...process.env, PATH: augmentedPath },
				}
			);

			let startupError = "";

			this.serverProcess.stderr?.on("data", (data: Buffer) => {
				const text = data.toString();
				for (const line of text.split(/[\n\r]+/)) {
					if (!line.trim()) continue;
					const progress = parseProgressOutput(line);
					if (progress) {
						if (this.pendingResponse?.onProgress) {
							this.pendingResponse.onProgress(progress);
						} else if (onProgress) {
							onProgress(progress);
						}
					}
					if (line.includes("Server ready")) {
						this.serverReady = true;
						startupSettled = true;
						this.resetIdleTimer();
						clearStartupTimer();
						resolve();
					}
				}
				startupError += text;
			});

			this.serverProcess.stdout?.on("data", (data: Buffer) => {
				this.responseBuffer += data.toString();
				this.processResponseBuffer();
			});

			this.serverProcess.on("error", (err) => {
				clearStartupTimer();
				this.serverReady = false;
				this.serverProcess = null;
				if (this.pendingResponse) {
					this.pendingResponse.reject(err);
					this.pendingResponse = null;
				} else if (!startupSettled) {
					startupSettled = true;
					reject(err);
				}
			});

			this.serverProcess.on("exit", (code) => {
				clearStartupTimer();
				const wasReady = this.serverReady;
				this.serverReady = false;
				this.serverProcess = null;
				if (this.pendingResponse) {
					this.pendingResponse.reject(new Error(`Speech server exited with code ${code}`));
					this.pendingResponse = null;
				} else if (!wasReady && !startupSettled) {
					startupSettled = true;
					reject(new Error(`Speech server exited during startup with code ${code}. Stderr: ${startupError}`));
				}
			});

			startupTimer = setTimeout(() => {
				if (!this.serverReady) {
					startupSettled = true;
					this.serverProcess?.kill();
					this.serverProcess = null;
					reject(new Error(`Speech server startup timeout. Stderr: ${startupError}`));
				}
			}, this.STARTUP_TIMEOUT_MS);
		});
	}

	private async runExclusive<T>(fn: () => Promise<T>): Promise<T> {
		const previous = this.requestLock.catch(() => undefined);
		let release: () => void = () => undefined;
		this.requestLock = new Promise<void>((resolve) => {
			release = resolve;
		});

		await previous;
		try {
			return await fn();
		} finally {
			release();
		}
	}

	private processResponseBuffer(): void {
		const lines = this.responseBuffer.split("\n");
		this.responseBuffer = lines.pop() || "";

		for (const line of lines) {
			if (!line.trim()) continue;
			try {
				const response: SpeechResponse = JSON.parse(line);
				if (this.pendingResponse) {
					this.pendingResponse.resolve(response);
					this.pendingResponse = null;
				}
			} catch {
				// Ignore non-JSON output.
			}
		}
	}

	private async sendRequest(
		request: SpeechRequest,
		onProgress?: (info: SpeechProgressInfo) => void,
		signal?: AbortSignal
	): Promise<SpeechResponse> {
		if (!this.serverProcess || !this.serverReady) {
			throw new Error("Speech server not ready");
		}
		if (this.pendingResponse) {
			throw new Error("Speech server is already handling a request");
		}

		return new Promise((resolve, reject) => {
			if (signal?.aborted) {
				reject(new Error("Aborted"));
				return;
			}

			const abortHandler = () => {
				if (this.pendingResponse) {
					this.pendingResponse = null;
					this.serverReady = false;
					this.serverProcess?.kill();
					this.serverProcess = null;
					reject(new Error("Aborted"));
				}
			};
			signal?.addEventListener("abort", abortHandler);

			this.pendingResponse = {
				resolve: (data) => {
					signal?.removeEventListener("abort", abortHandler);
					resolve(data);
				},
				reject: (err) => {
					signal?.removeEventListener("abort", abortHandler);
					reject(err);
				},
				onProgress,
			};

			this.serverProcess!.stdin?.write(JSON.stringify(request) + "\n");
		});
	}

	private resetIdleTimer(): void {
		if (this.idleTimer) {
			clearTimeout(this.idleTimer);
		}
		this.idleTimer = setTimeout(() => {
			this.shutdown();
		}, this.IDLE_TIMEOUT_MS);
	}

	shutdown(): void {
		if (this.idleTimer) {
			clearTimeout(this.idleTimer);
			this.idleTimer = null;
		}

		if (this.serverProcess) {
			try {
				this.serverProcess.stdin?.write(JSON.stringify({ action: "shutdown" }) + "\n");
			} catch {
				// Ignore write errors.
			}
			setTimeout(() => {
				if (this.serverProcess) {
					this.serverProcess.kill();
					this.serverProcess = null;
				}
			}, 1000);
			this.serverReady = false;
		}
	}

	async transcribe(audioFile: TFile, options: SpeechEngineOptions = {}): Promise<AlignmentData> {
		return this.runExclusive(() => this.transcribeExclusive(audioFile, options));
	}

	private async transcribeExclusive(audioFile: TFile, options: SpeechEngineOptions = {}): Promise<AlignmentData> {
		const adapter = this.app.vault.adapter;
		if (!(adapter instanceof FileSystemAdapter)) {
			throw new Error("Local transcription requires a file system adapter");
		}
		const basePath = adapter.getBasePath();
		const audioPath = path.join(basePath, audioFile.path);
		const modelPath = validateModelPath(options.modelPath);

		await this.ensureServer(options.onProgress);

		const request: SpeechRequest = {
			action: "transcribe",
			audio: audioPath,
			model: options.model || DEFAULT_PARAKEET_MODEL,
			modelPath,
			clampWordEnds: options.clampWordEnds ?? true,
		};

		if (options.start !== undefined) request.start = options.start;
		if (options.end !== undefined) request.end = options.end;
		if (options.skips && options.skips.length > 0) request.skips = options.skips;
		if (options.chunkDuration !== undefined) request.chunkDuration = options.chunkDuration;
		if (options.overlapDuration !== undefined) request.overlapDuration = options.overlapDuration;
		if (options.paragraphBreakGap !== undefined) request.paragraphBreakGap = options.paragraphBreakGap;

		let response = await this.sendRequest({
			...request,
			allowModelDownload: false,
		}, options.onProgress, options.signal);

		if (response.status === "error" && response.code === "model_download_required") {
			const shouldDownload = await requestModelDownload(
				this.app,
				response.modelSizeBytes ?? DEFAULT_MODEL_SIZE_BYTES
			);
			if (!shouldDownload) {
				throw new ModelDownloadCancelledError();
			}
			response = await this.sendRequest({
				...request,
				allowModelDownload: true,
			}, options.onProgress, options.signal);
		}

		if (response.status === "error") {
			throw new Error(`Transcription failed: ${response.message}`);
		}

		if (!response.result) {
			throw new Error("No result in transcription response");
		}

		const result = response.result;
		result.audioHash = await hashFile(this.app.vault, audioFile);
		result.transcriptHash = await hashString(result.text);
		result.tool = "parakeet-mlx";
		result.createdAt = Date.now();

		this.resetIdleTimer();
		return result;
	}
}

import { OpenAISpeechProvider } from "./openAiProvider";
import { GeminiSpeechProvider } from "./geminiProvider";
import { OpenRouterProvider } from "./openRouterProvider";

// Alias for backward compatibility
export const SpeechEngine = LocalParakeetEngine;

export class SpeechEngineManager {
	private localEngine: LocalParakeetEngine;
	private openAiProvider: OpenAISpeechProvider;
	private geminiProvider: GeminiSpeechProvider;
	private openRouterProvider: OpenRouterProvider;

	constructor(private app: App, pluginDir: string) {
		this.localEngine = new LocalParakeetEngine(app, pluginDir);
		this.openAiProvider = new OpenAISpeechProvider(app);
		this.geminiProvider = new GeminiSpeechProvider(app);
		this.openRouterProvider = new OpenRouterProvider(app);
	}

	getProvider(providerType: string = "local"): ITranscriptionProvider {
		if (providerType === "openai") return this.openAiProvider;
		if (providerType === "gemini") return this.geminiProvider;
		if (providerType === "openrouter") return this.openRouterProvider;
		return this.localEngine;
	}

	async transcribe(
		audioFile: TFile,
		options: SpeechEngineOptions & { providerType?: string } = {}
	): Promise<AlignmentData> {
		const provider = this.getProvider(options.providerType);
		return provider.transcribe(audioFile, options);
	}

	shutdown(): void {
		this.localEngine.shutdown();
	}
}

