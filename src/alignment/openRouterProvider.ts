import { App, TFile, requestUrl } from "obsidian";
import { hashFile, hashString } from "../core/hash";
import type { AlignedSegment, AlignedWord, AlignmentData } from "../types";
import type { ITranscriptionProvider, SpeechEngineOptions } from "./provider";

export class OpenRouterApiKeyMissingError extends Error {
	constructor() {
		super("OpenRouter API key is missing. Please configure it in plugin settings.");
		this.name = "OpenRouterApiKeyMissingError";
	}
}

interface OpenRouterWord {
	word: string;
	start: number;
	end: number;
}

interface OpenRouterResponseJSON {
	words: OpenRouterWord[];
	text?: string;
}

export class OpenRouterProvider implements ITranscriptionProvider {
	readonly id = "openrouter";
	readonly name = "OpenRouter (Gemini / Audio LLMs)";

	constructor(private app: App) {}

	async transcribe(audioFile: TFile, options: SpeechEngineOptions = {}): Promise<AlignmentData> {
		const apiKey = options.apiKey?.trim();
		if (!apiKey) {
			throw new OpenRouterApiKeyMissingError();
		}

		options.onProgress?.({ phase: "transcribing", percent: 10 });

		const arrayBuffer = await this.app.vault.readBinary(audioFile);
		const base64Audio = this.arrayBufferToBase64(arrayBuffer);
		const mimeType = this.getMimeType(audioFile.extension);
		const format = this.getAudioFormat(audioFile.extension);

		const modelName = options.model || "google/gemini-2.5-flash";
		const url = "https://openrouter.ai/api/v1/chat/completions";

		const prompt = `Transcribe the attached audio accurately. Return a JSON object matching this exact schema:
{
  "words": [
    { "word": "string", "start": 0.0, "end": 0.5 }
  ],
  "text": "full transcript string"
}
Ensure every single spoken word is listed in the 'words' array with precise start and end timestamps in seconds. Do not include markdown formatting codeblocks in raw response or return anything other than JSON.`;

		const payload = {
			model: modelName,
			messages: [
				{
					role: "user",
					content: [
						{ type: "text", text: prompt },
						{
							type: "input_audio",
							input_audio: {
								data: base64Audio,
								format: format,
							},
						},
					],
				},
			],
			response_format: { type: "json_object" },
		};

		options.onProgress?.({ phase: "transcribing", percent: 10 });

		let simulatedProgress = 10;
		const progressInterval = setInterval(() => {
			simulatedProgress += 5;
			if (simulatedProgress > 90) simulatedProgress = 90;
			options.onProgress?.({ phase: "transcribing", percent: simulatedProgress });
		}, 1000);

		let res;
		try {
			res = await requestUrl({
				url: url,
				method: "POST",
				headers: {
					Authorization: `Bearer ${apiKey}`,
					"HTTP-Referer": "https://obsidian.md",
					"X-Title": "Obsidian Interactive Transcripts",
					"Content-Type": "application/json",
				},
				body: JSON.stringify(payload),
			});
		} catch (err: any) {
			clearInterval(progressInterval);
			const status = err?.status || err?.statusCode || "Unknown";
			const responseText = err?.text || err?.message || String(err);
			throw new Error(`OpenRouter API request failed (${status}): ${responseText}`);
		}
		clearInterval(progressInterval);

		if (res.status >= 400) {
			throw new Error(`OpenRouter API error (${res.status}): ${res.text}`);
		}

		options.onProgress?.({ phase: "transcribing", percent: 80 });

		const responseData = res.json;
		const candidateText = responseData?.choices?.[0]?.message?.content;
		if (!candidateText) {
			throw new Error("OpenRouter API returned an empty response.");
		}

		let parsedJson: OpenRouterResponseJSON;
		try {
			// Strip markdown codeblock backticks if present
			const cleanedText = candidateText.replace(/^```json\s*/i, "").replace(/\s*```$/, "").trim();
			parsedJson = JSON.parse(cleanedText);
		} catch {
			throw new Error("Failed to parse JSON response from OpenRouter API.");
		}

		const alignment = await this.parseOpenRouterResult(parsedJson, audioFile, options);
		options.onProgress?.({ phase: "transcribing", percent: 100 });
		return alignment;
	}

	private arrayBufferToBase64(buffer: ArrayBuffer): string {
		let binary = "";
		const bytes = new Uint8Array(buffer);
		const len = bytes.byteLength;
		for (let i = 0; i < len; i++) {
			binary += String.fromCharCode(bytes[i]!);
		}
		return btoa(binary);
	}

	private getMimeType(ext: string): string {
		const lower = ext.toLowerCase();
		if (lower === "mp3") return "audio/mp3";
		if (lower === "m4a") return "audio/m4a";
		if (lower === "wav") return "audio/wav";
		if (lower === "ogg") return "audio/ogg";
		if (lower === "flac") return "audio/flac";
		if (lower === "webm") return "audio/webm";
		return "audio/mp3";
	}

	private async getAudioDuration(audioFile: TFile): Promise<number> {
		const url = this.app.vault.getResourcePath(audioFile);
		return new Promise((resolve) => {
			const audio = new Audio(url);
			audio.addEventListener("loadedmetadata", () => resolve(audio.duration));
			audio.addEventListener("error", () => resolve(0));
		});
	}

	private getAudioFormat(ext: string): string {
		const lower = ext.toLowerCase();
		if (lower === "mp3") return "mp3";
		if (lower === "m4a") return "m4a";
		if (lower === "wav") return "wav";
		if (lower === "ogg") return "ogg";
		if (lower === "flac") return "flac";
		if (lower === "webm") return "webm";
		return "mp3";
	}

	private async parseOpenRouterResult(
		raw: OpenRouterResponseJSON,
		audioFile: TFile,
		options: SpeechEngineOptions
	): Promise<AlignmentData> {
		const allWords: AlignedWord[] = (raw.words || []).map((w) => ({
			word: w.word,
			start: w.start,
			end: w.end,
		}));

		// Normalization: LLMs often hallucinate timestamps with wrong total duration.
		// Scale all timestamps linearly to match the actual audio file duration.
		const duration = await this.getAudioDuration(audioFile);
		if (duration > 0 && allWords.length > 0) {
			const maxEnd = Math.max(...allWords.map((w) => w.end));
			if (maxEnd > 0) {
				const scale = duration / maxEnd;
				for (const w of allWords) {
					w.start *= scale;
					w.end *= scale;
				}
			}
		}

		const startBound = options.start ?? 0;
		const endBound = options.end ?? Number.POSITIVE_INFINITY;
		const skips = options.skips || [];

		const filteredWords = allWords.filter((w) => {
			if (w.start < startBound || w.end > endBound) return false;
			for (const skip of skips) {
				if (w.start >= skip.start && w.end <= skip.end) return false;
			}
			return true;
		});

		const segments: AlignedSegment[] = [];
		if (filteredWords.length > 0) {
			let currentGroup: AlignedWord[] = [filteredWords[0]!];
			for (let i = 1; i < filteredWords.length; i++) {
				const prev = filteredWords[i - 1]!;
				const curr = filteredWords[i]!;
				if (curr.start - prev.end > (options.paragraphBreakGap ?? 1.5)) {
					segments.push({
						start: currentGroup[0]!.start,
						end: currentGroup[currentGroup.length - 1]!.end,
						text: currentGroup.map((w) => w.word.trim()).filter(Boolean).join(" "),
						words: currentGroup,
					});
					currentGroup = [curr];
				} else {
					currentGroup.push(curr);
				}
			}
			segments.push({
				start: currentGroup[0]!.start,
				end: currentGroup[currentGroup.length - 1]!.end,
				text: currentGroup.map((w) => w.word.trim()).filter(Boolean).join(" "),
				words: currentGroup,
			});
		}

		const fullText = segments.map((s) => s.text).join("\n\n") || raw.text || "";

		return {
			audioHash: await hashFile(this.app.vault, audioFile),
			transcriptHash: await hashString(fullText),
			language: "en",
			tool: "openrouter-stt",
			createdAt: Date.now(),
			segments,
			text: fullText,
		};
	}
}
