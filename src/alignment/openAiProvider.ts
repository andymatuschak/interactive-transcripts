import { App, FileSystemAdapter, TFile } from "obsidian";
import { hashFile, hashString } from "../core/hash";
import type { AlignedSegment, AlignedWord, AlignmentData } from "../types";
import type { ITranscriptionProvider, SpeechEngineOptions } from "./provider";

export class OpenAiApiKeyMissingError extends Error {
	constructor() {
		super("OpenAI API key is missing. Please configure it in plugin settings.");
		this.name = "OpenAiApiKeyMissingError";
	}
}

interface OpenAIWord {
	word: string;
	start: number;
	end: number;
}

interface OpenAISegment {
	id: number;
	start: number;
	end: number;
	text: string;
	words?: OpenAIWord[];
}

interface OpenAIVerboseResult {
	task: string;
	language: string;
	duration: number;
	text: string;
	words?: OpenAIWord[];
	segments?: OpenAISegment[];
}

export class OpenAISpeechProvider implements ITranscriptionProvider {
	readonly id = "openai";
	readonly name = "OpenAI Whisper";

	constructor(private app: App) {}

	async transcribe(audioFile: TFile, options: SpeechEngineOptions = {}): Promise<AlignmentData> {
		const apiKey = options.apiKey?.trim();
		if (!apiKey) {
			throw new OpenAiApiKeyMissingError();
		}

		options.onProgress?.({ phase: "transcribing", percent: 10 });

		const arrayBuffer = await this.app.vault.readBinary(audioFile);
		const fileBlob = new Blob([arrayBuffer], { type: this.getMimeType(audioFile.extension) });
		const file = new File([fileBlob], audioFile.name, { type: fileBlob.type });

		const formData = new FormData();
		formData.append("file", file);
		formData.append("model", options.model || "whisper-1");
		formData.append("response_format", "verbose_json");
		formData.append("timestamp_granularities[]", "word");
		formData.append("timestamp_granularities[]", "segment");

		options.onProgress?.({ phase: "transcribing", percent: 10 });

		let simulatedProgress = 10;
		const progressInterval = setInterval(() => {
			simulatedProgress += 5;
			if (simulatedProgress > 90) simulatedProgress = 90;
			options.onProgress?.({ phase: "transcribing", percent: simulatedProgress });
		}, 1000);

		let response;
		try {
			response = await fetch("https://api.openai.com/v1/audio/transcriptions", {
			method: "POST",
			headers: {
				Authorization: `Bearer ${apiKey}`,
			},
			body: formData,
			signal: options.signal,
		});

		} catch (err: any) {
			clearInterval(progressInterval);
			throw err;
		}
		clearInterval(progressInterval);

		if (!response.ok) {
			const errorText = await response.text();
			throw new Error(`OpenAI Whisper API error (${response.status}): ${errorText}`);
		}

		options.onProgress?.({ phase: "transcribing", percent: 80 });

		const rawResult: OpenAIVerboseResult = await response.json();
		const alignment = this.parseOpenAiResult(rawResult, audioFile, options);

		options.onProgress?.({ phase: "transcribing", percent: 100 });
		return alignment;
	}

	private getMimeType(ext: string): string {
		const lower = ext.toLowerCase();
		if (lower === "mp3") return "audio/mpeg";
		if (lower === "m4a") return "audio/mp4";
		if (lower === "wav") return "audio/wav";
		if (lower === "ogg") return "audio/ogg";
		if (lower === "flac") return "audio/flac";
		if (lower === "webm") return "audio/webm";
		return "application/octet-stream";
	}

	private async parseOpenAiResult(
		raw: OpenAIVerboseResult,
		audioFile: TFile,
		options: SpeechEngineOptions
	): Promise<AlignmentData> {
		const allWords: AlignedWord[] = (raw.words || []).map((w) => ({
			word: w.word,
			start: w.start,
			end: w.end,
		}));

		// Filter out words that fall into skip regions or outside start/end if specified
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

		// Group into segments based on 1.5s silence gap or raw segments
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

		const fullText = segments.map((s) => s.text).join("\n\n") || raw.text;

		return {
			audioHash: await hashFile(this.app.vault, audioFile),
			transcriptHash: await hashString(fullText),
			language: raw.language || "en",
			tool: "openai-whisper",
			createdAt: Date.now(),
			segments,
			text: fullText,
		};
	}
}
