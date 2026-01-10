import { App, TFile } from "obsidian";
import type { AlignmentData } from "../types";
import { hashFile, hashString, generateCacheKey } from "../core/hash";

const CACHE_DIR = ".obsidian/plugins/obsidian-transcript/cache";

/**
 * Manages caching of alignment data.
 */
export class AlignmentCache {
	constructor(private app: App) {}

	/**
	 * Get the cache directory path, creating it if needed.
	 */
	private async ensureCacheDir(): Promise<string> {
		const adapter = this.app.vault.adapter;
		if (!(await adapter.exists(CACHE_DIR))) {
			await adapter.mkdir(CACHE_DIR);
		}
		return CACHE_DIR;
	}

	/**
	 * Generate a cache key for an audio file and transcript.
	 */
	async getCacheKey(audioFile: TFile, transcriptText: string): Promise<string> {
		const audioHash = await hashFile(this.app.vault, audioFile);
		const transcriptHash = await hashString(transcriptText);
		return generateCacheKey(audioHash, transcriptHash);
	}

	/**
	 * Check if cached alignment exists for the given audio and transcript.
	 */
	async has(audioFile: TFile, transcriptText: string): Promise<boolean> {
		const cacheKey = await this.getCacheKey(audioFile, transcriptText);
		const cacheDir = await this.ensureCacheDir();
		const cachePath = `${cacheDir}/${cacheKey}`;
		return this.app.vault.adapter.exists(cachePath);
	}

	/**
	 * Get cached alignment data if it exists.
	 */
	async get(audioFile: TFile, transcriptText: string): Promise<AlignmentData | null> {
		const cacheKey = await this.getCacheKey(audioFile, transcriptText);
		const cacheDir = await this.ensureCacheDir();
		const cachePath = `${cacheDir}/${cacheKey}`;

		if (!(await this.app.vault.adapter.exists(cachePath))) {
			return null;
		}

		try {
			const content = await this.app.vault.adapter.read(cachePath);
			return JSON.parse(content) as AlignmentData;
		} catch {
			return null;
		}
	}

	/**
	 * Store alignment data in the cache.
	 */
	async set(audioFile: TFile, transcriptText: string, data: AlignmentData): Promise<void> {
		const cacheKey = await this.getCacheKey(audioFile, transcriptText);
		const cacheDir = await this.ensureCacheDir();
		const cachePath = `${cacheDir}/${cacheKey}`;

		await this.app.vault.adapter.write(cachePath, JSON.stringify(data, null, 2));
	}

	/**
	 * Remove cached alignment for the given audio and transcript.
	 */
	async remove(audioFile: TFile, transcriptText: string): Promise<void> {
		const cacheKey = await this.getCacheKey(audioFile, transcriptText);
		const cacheDir = await this.ensureCacheDir();
		const cachePath = `${cacheDir}/${cacheKey}`;

		if (await this.app.vault.adapter.exists(cachePath)) {
			await this.app.vault.adapter.remove(cachePath);
		}
	}

	/**
	 * Clear all cached alignments.
	 */
	async clearAll(): Promise<void> {
		const adapter = this.app.vault.adapter;
		if (await adapter.exists(CACHE_DIR)) {
			const files = await adapter.list(CACHE_DIR);
			for (const file of files.files) {
				await adapter.remove(file);
			}
		}
	}
}
