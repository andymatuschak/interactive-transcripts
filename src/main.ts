import { Plugin } from "obsidian";

export default class TranscriptPlugin extends Plugin {
	async onload(): Promise<void> {
		console.debug("Transcript plugin loaded");
	}

	onunload(): void {
		console.debug("Transcript plugin unloaded");
	}
}
