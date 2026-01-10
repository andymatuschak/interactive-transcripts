import { ChildProcess, spawn } from "child_process";
import * as fs from "fs";
import { App, FileSystemAdapter, TFile } from "obsidian";
import * as path from "path";
import { hashFile, hashString } from "../core/hash";
import type { AlignmentData } from "../types";

export type AlignmentTool = "whisperx" | "stable-ts";

/**
 * Progress phases during alignment.
 */
export type AlignmentPhase = "loading" | "aligning" | "adjusting";

/**
 * Structured progress callback from the aligner.
 */
export interface AlignmentProgressInfo {
	phase: AlignmentPhase;
	percent: number;
}

/**
 * Find the uv executable in common locations.
 */
function findUvPath(): string {
	const candidates = [
		"/opt/homebrew/bin/uv",
		"/usr/local/bin/uv",
		`${process.env.HOME}/.cargo/bin/uv`,
		`${process.env.HOME}/.local/bin/uv`,
	];

	for (const p of candidates) {
		if (fs.existsSync(p)) return p;
	}
	return "uv";
}

/**
 * Parse tqdm progress output from stable-ts.
 * Returns structured progress info or null if not a progress line.
 */
function parseProgressOutput(message: string): AlignmentProgressInfo | null {
	// Format: "Align:   5%|" or "Adjustment: 100%|"
	const alignMatch = message.match(/Align:\s*(\d+)%/);
	if (alignMatch && alignMatch[1]) {
		return { phase: "aligning", percent: parseInt(alignMatch[1], 10) };
	}

	const adjustMatch = message.match(/Adjustment:\s*(\d+)%/);
	if (adjustMatch && adjustMatch[1]) {
		return { phase: "adjusting", percent: parseInt(adjustMatch[1], 10) };
	}

	if (message.includes("Initializing") || message.includes("Loading")) {
		return { phase: "loading", percent: 0 };
	}

	if (message.includes("Trimming")) {
		return { phase: "loading", percent: 5 };
	}

	if (message.includes("Aligning")) {
		return { phase: "aligning", percent: 0 };
	}

	if (message.includes("Server ready")) {
		return { phase: "loading", percent: 10 };
	}

	return null;
}

export interface AlignerOptions {
	tool: AlignmentTool;
	model: string;
	language?: string;
	/** Start time in seconds for subrange alignment. */
	start?: number;
	/** End time in seconds for subrange alignment. */
	end?: number;
	/** Structured progress callback with parsed phase and percent. */
	onProgress?: (info: AlignmentProgressInfo) => void;
	/** Abort signal to cancel the alignment. */
	signal?: AbortSignal;
}

interface AlignRequest {
	action: "align";
	audio: string;
	text: string;
	tool: string;
	model: string;
	language?: string;
	start?: number;
	end?: number;
}

interface AlignResponse {
	status: "ok" | "error" | "shutdown";
	result?: AlignmentData;
	message?: string;
}

/**
 * Handles word-level alignment of audio with transcript text.
 * Uses a persistent Python server process for fast subsequent alignments.
 */
export class Aligner {
	private serverProcess: ChildProcess | null = null;
	private serverReady = false;
	private idleTimer: NodeJS.Timeout | null = null;
	private pendingResponse: {
		resolve: (data: AlignResponse) => void;
		reject: (err: Error) => void;
		onProgress?: (info: AlignmentProgressInfo) => void;
	} | null = null;
	private responseBuffer = "";

	private readonly IDLE_TIMEOUT_MS = 10 * 60 * 1000; // 10 minutes

	constructor(private app: App) {}

	/**
	 * Get the path to the Python alignment server script.
	 */
	private getServerScriptPath(): string {
		const adapter = this.app.vault.adapter;
		if (!(adapter instanceof FileSystemAdapter)) {
			throw new Error("Alignment requires a file system adapter");
		}
		const basePath = adapter.getBasePath();
		const pluginDir = path.join(basePath, ".obsidian", "plugins", "obsidian-transcript");
		return path.join(pluginDir, "python", "alignServer.py");
	}

	/**
	 * Get the Python project directory (for uv).
	 */
	private getPythonDir(): string {
		return path.dirname(this.getServerScriptPath());
	}

	/**
	 * Start the alignment server if not already running.
	 */
	private async ensureServer(onProgress?: (info: AlignmentProgressInfo) => void): Promise<void> {
		if (this.serverProcess && this.serverReady) {
			this.resetIdleTimer();
			return;
		}

		// Kill any existing non-ready server
		if (this.serverProcess) {
			this.serverProcess.kill();
			this.serverProcess = null;
		}

		const uvPath = findUvPath();
		const scriptPath = this.getServerScriptPath();
		const pythonDir = this.getPythonDir();

		// Augment PATH to include common locations for ffmpeg
		const extraPaths = ["/opt/homebrew/bin", "/usr/local/bin"];
		const currentPath = process.env.PATH || "";
		const augmentedPath = [...extraPaths, currentPath].join(":");

		return new Promise((resolve, reject) => {
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
				// Parse progress messages (split by \n or \r for tqdm updates)
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
						this.resetIdleTimer();
						resolve();
					}
				}
				// Collect for error reporting
				startupError += text;
			});

			this.serverProcess.stdout?.on("data", (data: Buffer) => {
				this.responseBuffer += data.toString();
				this.processResponseBuffer();
			});

			this.serverProcess.on("error", (err) => {
				this.serverReady = false;
				this.serverProcess = null;
				if (this.pendingResponse) {
					this.pendingResponse.reject(err);
					this.pendingResponse = null;
				} else {
					reject(err);
				}
			});

			this.serverProcess.on("exit", (code) => {
				this.serverReady = false;
				this.serverProcess = null;
				if (this.pendingResponse) {
					this.pendingResponse.reject(new Error(`Server exited with code ${code}`));
					this.pendingResponse = null;
				}
			});

			// Timeout for server startup
			setTimeout(() => {
				if (!this.serverReady) {
					this.serverProcess?.kill();
					this.serverProcess = null;
					reject(new Error(`Server startup timeout. Stderr: ${startupError}`));
				}
			}, 30000);
		});
	}

	/**
	 * Process buffered responses from stdout.
	 */
	private processResponseBuffer(): void {
		const lines = this.responseBuffer.split("\n");
		// Keep incomplete last line in buffer
		this.responseBuffer = lines.pop() || "";

		for (const line of lines) {
			if (!line.trim()) continue;
			try {
				const response: AlignResponse = JSON.parse(line);
				if (this.pendingResponse) {
					this.pendingResponse.resolve(response);
					this.pendingResponse = null;
				}
			} catch {
				// Ignore non-JSON lines
			}
		}
	}

	/**
	 * Send a request to the server and wait for response.
	 */
	private async sendRequest(
		request: AlignRequest,
		onProgress?: (info: AlignmentProgressInfo) => void,
		signal?: AbortSignal
	): Promise<AlignResponse> {
		if (!this.serverProcess || !this.serverReady) {
			throw new Error("Server not ready");
		}

		return new Promise((resolve, reject) => {
			// Handle abort
			if (signal?.aborted) {
				reject(new Error("Aborted"));
				return;
			}

			const abortHandler = () => {
				if (this.pendingResponse) {
					this.pendingResponse = null;
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

	/**
	 * Reset the idle timer.
	 */
	private resetIdleTimer(): void {
		if (this.idleTimer) {
			clearTimeout(this.idleTimer);
		}
		this.idleTimer = setTimeout(() => {
			this.shutdown();
		}, this.IDLE_TIMEOUT_MS);
	}

	/**
	 * Shutdown the server.
	 */
	shutdown(): void {
		if (this.idleTimer) {
			clearTimeout(this.idleTimer);
			this.idleTimer = null;
		}

		if (this.serverProcess) {
			// Try graceful shutdown
			try {
				this.serverProcess.stdin?.write(JSON.stringify({ action: "shutdown" }) + "\n");
			} catch {
				// Ignore write errors
			}
			// Force kill after a short delay
			setTimeout(() => {
				if (this.serverProcess) {
					this.serverProcess.kill();
					this.serverProcess = null;
				}
			}, 1000);
			this.serverReady = false;
		}
	}

	/**
	 * Run alignment on audio with transcript text.
	 * Returns alignment data with metadata (hashes, tool, timestamp).
	 */
	async align(
		audioFile: TFile,
		transcriptText: string,
		options: AlignerOptions
	): Promise<AlignmentData> {
		// Get absolute path to audio file
		const adapter = this.app.vault.adapter;
		if (!(adapter instanceof FileSystemAdapter)) {
			throw new Error("Alignment requires a file system adapter");
		}
		const basePath = adapter.getBasePath();
		const audioPath = path.join(basePath, audioFile.path);

		// Ensure server is running
		await this.ensureServer(options.onProgress);

		// Build request
		const request: AlignRequest = {
			action: "align",
			audio: audioPath,
			text: transcriptText,
			tool: options.tool,
			model: options.model,
		};

		if (options.language) {
			request.language = options.language;
		}

		if (options.start !== undefined) {
			request.start = options.start;
		}

		if (options.end !== undefined) {
			request.end = options.end;
		}

		// Send request and wait for response
		const response = await this.sendRequest(request, options.onProgress, options.signal);

		if (response.status === "error") {
			throw new Error(`Alignment failed: ${response.message}`);
		}

		if (!response.result) {
			throw new Error("No result in alignment response");
		}

		// Add metadata
		const alignmentResult = response.result;
		alignmentResult.audioHash = await hashFile(this.app.vault, audioFile);
		alignmentResult.transcriptHash = await hashString(transcriptText);
		alignmentResult.tool = options.tool;
		alignmentResult.createdAt = Date.now();

		this.resetIdleTimer();

		return alignmentResult;
	}
}
