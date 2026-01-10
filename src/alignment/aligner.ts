import { App, TFile, FileSystemAdapter } from "obsidian";
import type { AlignmentData } from "../types";
import { runSubprocess, SubprocessResult } from "./subprocess";
import { hashFile, hashString } from "../core/hash";
import * as path from "path";
import * as fs from "fs";

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
	const possiblePaths = [
		"/opt/homebrew/bin/uv",      // macOS ARM Homebrew
		"/usr/local/bin/uv",         // macOS Intel Homebrew
		`${process.env.HOME}/.cargo/bin/uv`,  // Cargo install
		`${process.env.HOME}/.local/bin/uv`,  // pipx or manual install
		"uv",                         // Fall back to PATH
	];

	for (const uvPath of possiblePaths) {
		if (uvPath === "uv") return uvPath; // Last resort
		try {
			if (fs.existsSync(uvPath)) {
				return uvPath;
			}
		} catch {
			// Continue to next path
		}
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

	if (message.includes("Loading")) {
		return { phase: "loading", percent: 0 };
	}

	return null;
}

export interface AlignerOptions {
	tool: AlignmentTool;
	model: string;
	language?: string;
	/** Structured progress callback with parsed phase and percent. */
	onProgress?: (info: AlignmentProgressInfo) => void;
	/** Abort signal to cancel the alignment. */
	signal?: AbortSignal;
}

/**
 * Handles word-level alignment of audio with transcript text.
 *
 * This class only runs the alignment subprocess. Cache management is handled
 * by AlignmentManager.
 */
export class Aligner {
	constructor(private app: App) {}

	/**
	 * Get the path to the Python alignment script.
	 */
	private getScriptPath(): string {
		const adapter = this.app.vault.adapter;
		if (!(adapter instanceof FileSystemAdapter)) {
			throw new Error("Alignment requires a file system adapter");
		}
		const basePath = adapter.getBasePath();
		const pluginDir = path.join(basePath, ".obsidian", "plugins", "obsidian-transcript");
		return path.join(pluginDir, "python", "align.py");
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

		// Build arguments for Python script
		const args = [
			"--audio", audioPath,
			"--text", transcriptText,
			"--tool", options.tool,
			"--model", options.model,
		];

		if (options.language) {
			args.push("--language", options.language);
		}

		const scriptPath = this.getScriptPath();
		const pythonDir = path.dirname(scriptPath);
		const uvPath = findUvPath();

		let result: SubprocessResult;
		try {
			result = await runSubprocess(
				uvPath,
				["run", "--project", pythonDir, "python", scriptPath, ...args],
				{
					timeout: 10 * 60 * 1000,
					signal: options.signal,
					onStderr: (data) => {
						// Parse progress from stderr and call structured callback
						const progress = parseProgressOutput(data);
						if (progress && options.onProgress) {
							options.onProgress(progress);
						}
					},
				}
			);
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			if (message === "Aborted") {
				throw err; // Re-throw abort errors as-is
			}
			throw new Error(`Alignment failed: ${message}`);
		}

		if (result.exitCode !== 0) {
			throw new Error(`Alignment failed with exit code ${result.exitCode}: ${result.stderr}`);
		}

		// Parse the JSON output
		let alignmentResult: AlignmentData;
		try {
			alignmentResult = JSON.parse(result.stdout);
		} catch {
			throw new Error(`Failed to parse alignment output: ${result.stdout.slice(0, 200)}`);
		}

		// Add metadata
		alignmentResult.audioHash = await hashFile(this.app.vault, audioFile);
		alignmentResult.transcriptHash = await hashString(transcriptText);
		alignmentResult.tool = options.tool;
		alignmentResult.createdAt = Date.now();

		return alignmentResult;
	}
}
