import { App, PluginSettingTab, Setting } from "obsidian";

export interface TranscriptPluginSettings {
	geminiApiKey: string;
}

export const DEFAULT_SETTINGS: TranscriptPluginSettings = {
	geminiApiKey: "",
};

export class TranscriptSettingTab extends PluginSettingTab {
	private getSettings: () => TranscriptPluginSettings;
	private saveSettings: (settings: TranscriptPluginSettings) => Promise<void>;

	constructor(
		app: App,
		plugin: { app: App },
		getSettings: () => TranscriptPluginSettings,
		saveSettings: (settings: TranscriptPluginSettings) => Promise<void>
	) {
		super(app, plugin as any);
		this.getSettings = getSettings;
		this.saveSettings = saveSettings;
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();

		new Setting(containerEl)
			.setName("Gemini API key")
			.setDesc("API key for Google Gemini audio transcription")
			.addText((text) =>
				text
					.setPlaceholder("Enter your API key")
					.setValue(this.getSettings().geminiApiKey)
					.then((t) => (t.inputEl.type = "password"))
					.onChange(async (value) => {
						const settings = this.getSettings();
						settings.geminiApiKey = value;
						await this.saveSettings(settings);
					})
			);
	}
}
