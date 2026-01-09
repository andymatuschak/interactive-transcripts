import { TFile, Vault } from "obsidian";

/**
 * Compute SHA-256 hash of a string.
 */
export async function hashString(text: string): Promise<string> {
	const encoder = new TextEncoder();
	const data = encoder.encode(text);
	const hashBuffer = await crypto.subtle.digest("SHA-256", data);
	const hashArray = Array.from(new Uint8Array(hashBuffer));
	return hashArray.map(b => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Compute SHA-256 hash of a file's contents.
 */
export async function hashFile(vault: Vault, file: TFile): Promise<string> {
	const arrayBuffer = await vault.readBinary(file);
	const hashBuffer = await crypto.subtle.digest("SHA-256", arrayBuffer);
	const hashArray = Array.from(new Uint8Array(hashBuffer));
	return hashArray.map(b => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Generate a cache key from audio and transcript hashes.
 * Uses truncated hashes for shorter filenames.
 */
export function generateCacheKey(audioHash: string, transcriptHash: string): string {
	return `${audioHash.slice(0, 8)}_${transcriptHash.slice(0, 8)}.json`;
}
