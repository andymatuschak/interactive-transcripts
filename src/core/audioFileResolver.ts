import type { App, TFile } from "obsidian";

export type AudioFileLookup = {
	vault: Pick<App["vault"], "getFileByPath">;
	metadataCache: Pick<App["metadataCache"], "getFirstLinkpathDest">;
};

/**
 * Resolve a transcript's audio reference using the same link semantics as
 * Obsidian embeds, with an exact-path fallback for canonical vault paths.
 */
export function resolveAudioFile(
	app: AudioFileLookup,
	audioPath: string,
	sourcePath = ""
): TFile | null {
	return (
		app.metadataCache.getFirstLinkpathDest(audioPath, sourcePath)
		?? app.vault.getFileByPath(audioPath)
	);
}
