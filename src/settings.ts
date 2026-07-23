import { App, Plugin, PluginSettingTab, Setting } from "obsidian";
import { DEFAULT_PARAKEET_MODEL } from "./alignment/speechEngine";
import type { SpeechProviderType } from "./types";

export interface TranscriptPluginSettings {
	speechProvider: SpeechProviderType;
	openAiApiKey: string;
	openAiModel: string;
	geminiApiKey: string;
	geminiModel: string;
	openRouterApiKey: string;
	openRouterModel: string;
	parakeetModel: string;
	modelPath: string;
	parakeetChunkDuration: number;
	parakeetOverlapDuration: number;
	paragraphBreakGap: number;
	clampWordEnds: boolean;
}

export const DEFAULT_SETTINGS: TranscriptPluginSettings = {
	speechProvider: "local",
	openAiApiKey: "",
	openAiModel: "whisper-1",
	geminiApiKey: "",
	geminiModel: "gemini-2.0-flash",
	openRouterApiKey: "",
	openRouterModel: "google/gemini-2.5-flash",
	parakeetModel: DEFAULT_PARAKEET_MODEL,
	modelPath: "",
	parakeetChunkDuration: 120,
	parakeetOverlapDuration: 15,
	paragraphBreakGap: 2,
	clampWordEnds: true,
};

export class TranscriptSettingTab extends PluginSettingTab {
	private getSettings: () => TranscriptPluginSettings;
	private saveSettings: (settings: TranscriptPluginSettings) => Promise<void>;

	constructor(
		app: App,
		plugin: Plugin,
		getSettings: () => TranscriptPluginSettings,
		saveSettings: (settings: TranscriptPluginSettings) => Promise<void>
	) {
		super(app, plugin);
		this.getSettings = getSettings;
		this.saveSettings = saveSettings;
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();

		new Setting(containerEl)
			.setName("Speech transcription provider")
			.setDesc("Choose between local speech recognition (Apple Silicon) or cloud providers")
			.addDropdown((dropdown) =>
				dropdown
					.addOption("local", "Local (Parakeet-MLX)")
					.addOption("openai", "OpenAI (Whisper API)")
					.addOption("gemini", "Google Gemini (Gemini API)")
					.addOption("openrouter", "OpenRouter (Gemini / Multimodal Models)")
					.setValue(this.getSettings().speechProvider || "local")
					.onChange(async (value) => {
						const settings = this.getSettings();
						settings.speechProvider = value as SpeechProviderType;
						await this.saveSettings(settings);
						this.display();
					})
			);

		const currentProvider = this.getSettings().speechProvider || "local";

		if (currentProvider === "openai") {
			new Setting(containerEl)
				.setName("OpenAI API key")
				.setDesc("API Key for OpenAI Whisper audio transcription")
				.addText((text) =>
					text
						.setPlaceholder("sk-...")
						.setValue(this.getSettings().openAiApiKey)
						.onChange(async (value) => {
							const settings = this.getSettings();
							settings.openAiApiKey = value.trim();
							await this.saveSettings(settings);
						})
				);

			new Setting(containerEl)
				.setName("OpenAI Whisper model")
				.setDesc("Model name to use for Whisper API")
				.addText((text) =>
					text
						.setPlaceholder("whisper-1")
						.setValue(this.getSettings().openAiModel || "whisper-1")
						.onChange(async (value) => {
							const settings = this.getSettings();
							settings.openAiModel = value.trim() || "whisper-1";
							await this.saveSettings(settings);
						})
				);
		} else if (currentProvider === "gemini") {
			new Setting(containerEl)
				.setName("Gemini API key")
				.setDesc("API Key for Google Gemini audio transcription")
				.addText((text) =>
					text
						.setPlaceholder("AIzaSy...")
						.setValue(this.getSettings().geminiApiKey)
						.onChange(async (value) => {
							const settings = this.getSettings();
							settings.geminiApiKey = value.trim();
							await this.saveSettings(settings);
						})
				);

			new Setting(containerEl)
				.setName("Gemini model")
				.setDesc("Model name for Gemini STT")
				.addText((text) =>
					text
						.setPlaceholder("gemini-2.0-flash")
						.setValue(this.getSettings().geminiModel || "gemini-2.0-flash")
						.onChange(async (value) => {
							const settings = this.getSettings();
							settings.geminiModel = value.trim() || "gemini-2.0-flash";
							await this.saveSettings(settings);
						})
				);
		} else if (currentProvider === "openrouter") {
			new Setting(containerEl)
				.setName("OpenRouter API key")
				.setDesc("API Key for OpenRouter API")
				.addText((text) =>
					text
						.setPlaceholder("sk-or-...")
						.setValue(this.getSettings().openRouterApiKey)
						.onChange(async (value) => {
							const settings = this.getSettings();
							settings.openRouterApiKey = value.trim();
							await this.saveSettings(settings);
						})
				);

			new Setting(containerEl)
				.setName("OpenRouter model")
				.setDesc("Select an audio-capable model on OpenRouter")
				.addDropdown((dropdown) =>
					dropdown
						.addOption("google/gemini-2.5-flash", "Gemini 2.5 Flash")
						.addOption("google/gemini-2.5-pro", "Gemini 2.5 Pro")
						.addOption("google/gemini-2.0-flash-001", "Gemini 2.0 Flash 001")
						.addOption("openai/gpt-4o", "OpenAI GPT-4o")
						.addOption("openai/gpt-4o-mini", "OpenAI GPT-4o Mini")
						.addOption("anthropic/claude-3.5-sonnet", "Claude 3.5 Sonnet")
						.addOption("qwen/qwen-vl-plus", "Qwen VL Plus")
						.addOption("meta-llama/llama-3.2-90b-vision-instruct", "Llama 3.2 90B Vision")
						.setValue(this.getSettings().openRouterModel || "google/gemini-2.5-flash")
						.onChange(async (value) => {
							const settings = this.getSettings();
							settings.openRouterModel = value;
							await this.saveSettings(settings);
						})
				);
		} else {
			new Setting(containerEl)
				.setName("Model path")
				.setDesc("Optional local model folder containing config.json and model.safetensors")
				.addText((text) =>
					text
						.setPlaceholder("/path/to/model")
						.setValue(this.getSettings().modelPath)
						.onChange(async (value) => {
							const settings = this.getSettings();
							settings.modelPath = value.trim();
							await this.saveSettings(settings);
						})
				);
		}


		new Setting(containerEl)
			.setName("Chunk duration")
			.setDesc("Seconds per long-audio chunk; use 0 to disable chunking")
			.addText((text) =>
				text
					.setPlaceholder("120")
					.setValue(String(this.getSettings().parakeetChunkDuration))
					.onChange(async (value) => {
						const parsed = Number(value);
						const settings = this.getSettings();
						settings.parakeetChunkDuration = Number.isFinite(parsed) && parsed >= 0 ? parsed : DEFAULT_SETTINGS.parakeetChunkDuration;
						await this.saveSettings(settings);
					})
			);

		new Setting(containerEl)
			.setName("Overlap duration")
			.setDesc("Seconds of overlap between chunks")
			.addText((text) =>
				text
					.setPlaceholder("15")
					.setValue(String(this.getSettings().parakeetOverlapDuration))
					.onChange(async (value) => {
						const parsed = Number(value);
						const settings = this.getSettings();
						settings.parakeetOverlapDuration = Number.isFinite(parsed) && parsed >= 0 ? parsed : DEFAULT_SETTINGS.parakeetOverlapDuration;
						await this.saveSettings(settings);
					})
			);

		new Setting(containerEl)
			.setName("Paragraph break gap")
			.setDesc("Seconds of silence between segments that creates a paragraph break; use 0 to disable")
			.addText((text) =>
				text
					.setPlaceholder("2")
					.setValue(String(this.getSettings().paragraphBreakGap))
					.onChange(async (value) => {
						const parsed = Number(value);
						const settings = this.getSettings();
						settings.paragraphBreakGap = Number.isFinite(parsed) && parsed >= 0 ? parsed : DEFAULT_SETTINGS.paragraphBreakGap;
						await this.saveSettings(settings);
					})
			);

		new Setting(containerEl)
			.setName("Clamp long word endings")
			.setDesc("Shorten occasional word spans that stretch across silence")
			.addToggle((toggle) =>
				toggle
					.setValue(this.getSettings().clampWordEnds)
					.onChange(async (value) => {
						const settings = this.getSettings();
						settings.clampWordEnds = value;
						await this.saveSettings(settings);
					})
			);
	}
}

