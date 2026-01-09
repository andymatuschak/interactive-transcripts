import { App, TFile, FileSystemAdapter } from "obsidian";
import type { AlignmentData } from "../types";
import { runSubprocess, SubprocessResult } from "./subprocess";
import { AlignmentCache } from "./cache";
import { hashFile, hashString } from "../core/hash";
import * as path from "path";

export type AlignmentTool = "whisperx" | "stable-ts";

export interface AlignerOptions {
	tool: AlignmentTool;
	model: string;
	language?: string;
	onProgress?: (message: string) => void;
}

/**
 * Handles word-level alignment of audio with transcript text.
 */
export class Aligner {
	private cache: AlignmentCache;

	constructor(private app: App) {
		this.cache = new AlignmentCache(app);
	}

	/**
	 * Get the path to the Python alignment script.
	 */
	private getScriptPath(): string {
		// The script is bundled with the plugin
		const pluginDir = this.app.vault.configDir + "/plugins/markdown-audio-transcripts";
		return path.join(pluginDir, "python", "align.py");
	}

	/**
	 * Align audio with transcript text, using cache if available.
	 */
	async align(
		audioFile: TFile,
		transcriptText: string,
		options: AlignerOptions
	): Promise<AlignmentData> {
		// Check cache first
		const cached = await this.cache.get(audioFile, transcriptText);
		if (cached) {
			options.onProgress?.("Using cached alignment");
			return cached;
		}

		// Get absolute path to audio file
		const adapter = this.app.vault.adapter;
		if (!(adapter instanceof FileSystemAdapter)) {
			throw new Error("Alignment requires a file system adapter");
		}
		const basePath = adapter.getBasePath();
		const audioPath = path.join(basePath, audioFile.path);

		options.onProgress?.(`Starting alignment with ${options.tool}...`);

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

		// Run the alignment script via uv
		let result: SubprocessResult;
		const scriptPath = this.getScriptPath();
		const pythonDir = path.dirname(scriptPath);

		try {
			result = await runSubprocess(
				"uv",
				["run", "--project", pythonDir, "python", scriptPath, ...args],
				{
					timeout: 10 * 60 * 1000,
					onStderr: (data) => {
						const progressMatch = data.match(/Progress: (.+)/);
						if (progressMatch && progressMatch[1]) {
							options.onProgress?.(progressMatch[1]);
						}
					},
				}
			);
		} catch (err) {
			throw new Error(`Alignment failed: ${err instanceof Error ? err.message : String(err)}`);
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

		// Cache the result
		await this.cache.set(audioFile, transcriptText, alignmentResult);

		options.onProgress?.("Alignment complete");

		return alignmentResult;
	}

	/**
	 * Check if alignment is cached for the given audio and transcript.
	 */
	async isCached(audioFile: TFile, transcriptText: string): Promise<boolean> {
		return this.cache.has(audioFile, transcriptText);
	}

	/**
	 * Get cached alignment without running alignment.
	 */
	async getCached(audioFile: TFile, transcriptText: string): Promise<AlignmentData | null> {
		return this.cache.get(audioFile, transcriptText);
	}

	/**
	 * Clear cached alignment for the given audio and transcript.
	 */
	async clearCache(audioFile: TFile, transcriptText: string): Promise<void> {
		await this.cache.remove(audioFile, transcriptText);
	}

	/**
	 * Clear all cached alignments.
	 */
	async clearAllCache(): Promise<void> {
		await this.cache.clearAll();
	}
}
