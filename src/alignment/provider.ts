import { TFile } from "obsidian";
import type { AlignmentData, SpeechProviderType } from "../types";

export type SpeechPhase = "downloading" | "transcribing";

export interface SpeechProgressInfo {
	phase: SpeechPhase;
	percent: number;
}

export interface SpeechEngineOptions {
	model?: string;
	modelPath?: string;
	start?: number;
	end?: number;
	skips?: Array<{ start: number; end: number }>;
	chunkDuration?: number;
	overlapDuration?: number;
	paragraphBreakGap?: number;
	clampWordEnds?: boolean;
	apiKey?: string;
	onProgress?: (info: SpeechProgressInfo) => void;
	signal?: AbortSignal;
}

export interface ITranscriptionProvider {
	readonly id: SpeechProviderType;
	readonly name: string;
	transcribe(audioFile: TFile, options?: SpeechEngineOptions): Promise<AlignmentData>;
}
