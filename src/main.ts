import { Notice, Plugin } from "obsidian";
import { transcriptField } from "./editor/state";
import { wordHighlightField } from "./editor/highlightState";
import { livePreviewField, livePreviewDetector } from "./editor/editorMode";
import { transcriptViewPlugin } from "./editor/viewPlugin";
import { clickToSeekExtension } from "./editor/clickToSeek";
import { copyHandlerExtension } from "./editor/copyHandler";
import { AudioManager } from "./playback/audioManager";
import { floatingControlsPlugin } from "./playback/floatingControls";
import { highlightSyncPlugin } from "./playback/highlightSync";
import { initAlignmentLoader, alignmentLoaderPlugin } from "./alignment/alignmentLoader";
import { AlignmentManager } from "./alignment/alignmentManager";
import { transcriptEditingExtension } from "./editor/transcriptEditing";
import { TranscriptSettingTab, DEFAULT_SETTINGS, type TranscriptPluginSettings } from "./settings";
import { serializeDirective } from "./core/serializer";
import { transcribeAudio, mimeTypeForExtension } from "./transcription/transcriber";

const AUDIO_EMBED_REGEX = /!\[\[(.+?\.(m4a|mp3|mp4|wav|ogg|webm|flac))\]\]/i;

export default class TranscriptPlugin extends Plugin {
	settings: TranscriptPluginSettings = DEFAULT_SETTINGS;

	async onload(): Promise<void> {
		console.debug("Transcript plugin loaded");

		await this.loadSettings();

		// Initialize singletons
		AudioManager.initialize(this.app);
		initAlignmentLoader(this.app);

		this.addSettingTab(
			new TranscriptSettingTab(
				this.app,
				this,
				() => this.settings,
				async (s) => {
					this.settings = s;
					await this.saveSettings();
				}
			)
		);

		// Register CodeMirror extensions
		this.registerEditorExtension([
			transcriptField,
			wordHighlightField,
			livePreviewField,
			livePreviewDetector,
			transcriptViewPlugin,
			clickToSeekExtension,
			copyHandlerExtension,
			alignmentLoaderPlugin,
			floatingControlsPlugin,
			highlightSyncPlugin,
			transcriptEditingExtension,
		]);

		this.addCommand({
			id: "transcribe-audio",
			name: "Transcribe audio with Gemini",
			editorCallback: async (editor, view) => {
				const line = editor.getLine(editor.getCursor().line);
				const match = line.match(AUDIO_EMBED_REGEX);
				if (!match) {
					new Notice("Place cursor on an audio embed like ![[file.m4a]]");
					return;
				}

				const apiKey = this.settings.geminiApiKey;
				if (!apiKey) {
					new Notice("Set your Gemini API key in Transcript plugin settings");
					return;
				}

				const linkpath = match[1]!;
				const ext = match[2]!;
				const mimeType = mimeTypeForExtension(ext);
				if (!mimeType) {
					new Notice(`Unsupported audio format: ${ext}`);
					return;
				}

				const currentFile = view.file;
				if (!currentFile) {
					new Notice("No active file");
					return;
				}

				const audioFile = this.app.metadataCache.getFirstLinkpathDest(
					linkpath,
					currentFile.path
				);
				if (!audioFile) {
					new Notice(`Audio file not found: ${linkpath}`);
					return;
				}

				const notice = new Notice("Transcribing audio...", 0);
				try {
					const audioData = await this.app.vault.readBinary(audioFile);
					const transcript = await transcribeAudio(audioData, mimeType, apiKey);

					const directive = serializeDirective({
						audioPath: linkpath,
						attributes: {},
						content: transcript,
						from: 0,
						to: 0,
						contentFrom: 0,
					});

					const cursorLine = editor.getCursor().line;
					editor.replaceRange(
						directive,
						{ line: cursorLine, ch: 0 },
						{ line: cursorLine, ch: editor.getLine(cursorLine).length }
					);

					notice.hide();
					new Notice("Transcription complete");
				} catch (err) {
					notice.hide();
					const msg = err instanceof Error ? err.message : String(err);
					new Notice(`Transcription failed: ${msg}`);
				}
			},
		});
	}

	async loadSettings(): Promise<void> {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
	}

	async saveSettings(): Promise<void> {
		await this.saveData(this.settings);
	}

	onunload(): void {
		AudioManager.destroy();
		AlignmentManager.destroy();
		console.debug("Transcript plugin unloaded");
	}
}
