import { describe, expect, test, mock } from "bun:test";

mock.module("obsidian", () => ({
	requestUrl: async () => ({ status: 200, json: {}, text: "{}" }),
	App: class {},
	TFile: class {},
}));

const { OpenAISpeechProvider, OpenAiApiKeyMissingError } = await import("./openAiProvider");
const { GeminiSpeechProvider, GeminiApiKeyMissingError } = await import("./geminiProvider");
const { OpenRouterProvider, OpenRouterApiKeyMissingError } = await import("./openRouterProvider");

describe("OpenAISpeechProvider", () => {
	test("throws error when API key is missing", async () => {
		const fakeApp: any = { vault: {} };
		const provider = new OpenAISpeechProvider(fakeApp);
		const fakeFile: any = { path: "test.mp3", name: "test.mp3", extension: "mp3" };

		expect(provider.transcribe(fakeFile, { apiKey: "" })).rejects.toThrow(OpenAiApiKeyMissingError);
	});
});

describe("GeminiSpeechProvider", () => {
	test("throws error when API key is missing", async () => {
		const fakeApp: any = { vault: {} };
		const provider = new GeminiSpeechProvider(fakeApp);
		const fakeFile: any = { path: "test.mp3", name: "test.mp3", extension: "mp3" };

		expect(provider.transcribe(fakeFile, { apiKey: "" })).rejects.toThrow(GeminiApiKeyMissingError);
	});
});

describe("OpenRouterProvider", () => {
	test("throws error when API key is missing", async () => {
		const fakeApp: any = { vault: {} };
		const provider = new OpenRouterProvider(fakeApp);
		const fakeFile: any = { path: "test.mp3", name: "test.mp3", extension: "mp3" };

		expect(provider.transcribe(fakeFile, { apiKey: "" })).rejects.toThrow(OpenRouterApiKeyMissingError);
	});
});
