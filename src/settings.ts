import { App, Plugin, PluginSettingTab, Setting } from "obsidian";
import { DEFAULT_PARAKEET_MODEL } from "./alignment/speechEngine";

export interface TranscriptPluginSettings {
	parakeetModel: string;
	modelPath: string;
	parakeetChunkDuration: number;
	parakeetOverlapDuration: number;
	paragraphBreakGap: number;
	clampWordEnds: boolean;
}

export const DEFAULT_SETTINGS: TranscriptPluginSettings = {
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
