import { describe, expect, test } from "bun:test";
import type { TFile } from "obsidian";
import { resolveAudioFile, type AudioFileLookup } from "./audioFileResolver";

function createLookup(
	linkedFile: TFile | null,
	exactFile: TFile | null = null
): AudioFileLookup {
	return {
		metadataCache: {
			getFirstLinkpathDest: () => linkedFile,
		},
		vault: {
			getFileByPath: () => exactFile,
		},
	};
}

describe("resolveAudioFile", () => {
	test("resolves a basename-only link to audio in a subfolder", () => {
		const nestedAudio = { path: "Files/interview.m4a" } as TFile;
		const app = createLookup(nestedAudio);

		expect(resolveAudioFile(app, "interview.m4a", "Notes/transcript.md"))
			.toBe(nestedAudio);
	});

	test("passes the containing note path to Obsidian's link resolver", () => {
		const nestedAudio = { path: "Files/interview.m4a" } as TFile;
		let receivedSourcePath = "";
		const app = createLookup(nestedAudio);
		app.metadataCache.getFirstLinkpathDest = (_linkpath, sourcePath) => {
			receivedSourcePath = sourcePath;
			return nestedAudio;
		};

		resolveAudioFile(app, "interview.m4a", "Notes/transcript.md");

		expect(receivedSourcePath).toBe("Notes/transcript.md");
	});

	test("falls back to an exact canonical vault path", () => {
		const nestedAudio = { path: "Files/interview.m4a" } as TFile;
		const app = createLookup(null, nestedAudio);

		expect(resolveAudioFile(app, "Files/interview.m4a"))
			.toBe(nestedAudio);
	});

	test("returns null when neither lookup finds the audio", () => {
		const app = createLookup(null);

		expect(resolveAudioFile(app, "missing.m4a", "Notes/transcript.md"))
			.toBeNull();
	});
});
