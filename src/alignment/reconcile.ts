import type { AlignmentData, AlignedSegment, AlignedWord } from "../types";

const WORD_PATTERN = /[A-Za-z0-9]+(?:'[A-Za-z0-9]+)?[^\sA-Za-z0-9]*/g;
const NORMALIZE_PATTERN = /[a-z0-9']+/g;

interface TextToken {
	surface: string;
	normalized: string;
}

interface SourceToken {
	normalized: string;
	word: AlignedWord;
}

export interface ReconcileResult {
	alignment: AlignmentData;
	similarity: number;
}

function normalizeToken(text: string): string {
	return (text.toLowerCase().match(NORMALIZE_PATTERN) || []).join("");
}

function tokenizeText(text: string): TextToken[] {
	const tokens: TextToken[] = [];
	for (const match of text.matchAll(WORD_PATTERN)) {
		const surface = match[0];
		const normalized = normalizeToken(surface);
		if (normalized) {
			tokens.push({ surface, normalized });
		}
	}
	return tokens;
}

function sourceTokens(alignment: AlignmentData): SourceToken[] {
	const tokens: SourceToken[] = [];
	for (const segment of alignment.segments) {
		for (const word of segment.words) {
			const normalized = normalizeToken(word.word);
			if (normalized) {
				tokens.push({ normalized, word });
			}
		}
	}
	return tokens;
}

function alignmentPairs(a: string[], b: string[]): Array<[number | null, number | null]> {
	const rows = a.length + 1;
	const cols = b.length + 1;
	const costs: number[][] = Array.from({ length: rows }, () => Array(cols).fill(0));

	for (let i = 1; i < rows; i++) costs[i]![0] = i;
	for (let j = 1; j < cols; j++) costs[0]![j] = j;

	for (let i = 1; i < rows; i++) {
		for (let j = 1; j < cols; j++) {
			const substitution = costs[i - 1]![j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1);
			const deletion = costs[i - 1]![j]! + 1;
			const insertion = costs[i]![j - 1]! + 1;
			costs[i]![j] = Math.min(substitution, deletion, insertion);
		}
	}

	const pairs: Array<[number | null, number | null]> = [];
	let i = a.length;
	let j = b.length;

	while (i > 0 || j > 0) {
		if (
			i > 0 &&
			j > 0 &&
			costs[i]![j] === costs[i - 1]![j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1)
		) {
			pairs.push([i - 1, j - 1]);
			i--;
			j--;
		} else if (i > 0 && costs[i]![j] === costs[i - 1]![j]! + 1) {
			pairs.push([i - 1, null]);
			i--;
		} else {
			pairs.push([null, j - 1]);
			j--;
		}
	}

	return pairs.reverse();
}

function estimateDuration(surface: string): number {
	const letters = normalizeToken(surface).length;
	return Math.min(0.6, Math.max(0.18, 0.055 * letters + 0.08));
}

function fillMissingTimes(words: AlignedWord[]): void {
	for (let i = 0; i < words.length; i++) {
		const word = words[i]!;
		if (Number.isFinite(word.start) && Number.isFinite(word.end)) continue;

		let prev: AlignedWord | null = null;
		for (let p = i - 1; p >= 0; p--) {
			const candidate = words[p]!;
			if (Number.isFinite(candidate.start) && Number.isFinite(candidate.end)) {
				prev = candidate;
				break;
			}
		}

		let next: AlignedWord | null = null;
		for (let n = i + 1; n < words.length; n++) {
			const candidate = words[n]!;
			if (Number.isFinite(candidate.start) && Number.isFinite(candidate.end)) {
				next = candidate;
				break;
			}
		}

		const duration = estimateDuration(word.word);
		if (prev && next && next.start > prev.end) {
			const gapStart = prev.end;
			const gapEnd = next.start;
			const gapWords = words
				.slice(words.indexOf(prev) + 1, words.indexOf(next))
				.filter(w => !Number.isFinite(w.start) || !Number.isFinite(w.end));
			const slot = gapWords.findIndex(w => w === word);
			const step = (gapEnd - gapStart) / Math.max(1, gapWords.length);
			word.start = gapStart + step * Math.max(0, slot);
			word.end = Math.min(gapEnd, word.start + Math.min(duration, Math.max(0.05, step * 0.8)));
		} else if (prev) {
			word.start = prev.end;
			word.end = word.start + duration;
		} else if (next) {
			word.end = next.start;
			word.start = Math.max(0, word.end - duration);
		} else {
			word.start = 0;
			word.end = duration;
		}
	}
}

function buildSegments(base: AlignmentData, text: string, words: AlignedWord[]): AlignedSegment[] {
	if (words.length === 0) return [];

	const segments: AlignedSegment[] = [];
	let current: AlignedWord[] = [];

	const flush = () => {
		if (current.length === 0) return;
		segments.push({
			start: current[0]!.start,
			end: current[current.length - 1]!.end,
			text: current.map(w => w.word).join(" "),
			words: current,
		});
		current = [];
	};

	for (const word of words) {
		const previous = current[current.length - 1];
		if (previous) {
			const gap = word.start - previous.end;
			if (gap > 1.0 || /[.!?]$/.test(previous.word)) {
				flush();
			}
		}
		current.push(word);
	}
	flush();

	return segments.map(segment => ({ ...segment, text: segment.text || base.text || text }));
}

export function reconcileAlignmentToText(
	source: AlignmentData,
	targetText: string,
	minSimilarity = 0.65
): ReconcileResult | null {
	const sourceItems = sourceTokens(source);
	const targetItems = tokenizeText(targetText);

	if (sourceItems.length === 0 || targetItems.length === 0) {
		return null;
	}

	const pairs = alignmentPairs(
		sourceItems.map(item => item.normalized),
		targetItems.map(item => item.normalized)
	);
	const distance = pairs.filter(([sourceIndex, targetIndex]) => {
		if (sourceIndex === null || targetIndex === null) return true;
		return sourceItems[sourceIndex]!.normalized !== targetItems[targetIndex]!.normalized;
	}).length;
	const similarity = 1 - distance / Math.max(sourceItems.length, targetItems.length);

	if (similarity < minSimilarity) {
		return null;
	}

	const words: AlignedWord[] = [];
	for (const [sourceIndex, targetIndex] of pairs) {
		if (targetIndex === null) continue;
		const target = targetItems[targetIndex]!;

		if (sourceIndex !== null) {
			const sourceWord = sourceItems[sourceIndex]!.word;
			const exact = sourceItems[sourceIndex]!.normalized === target.normalized;
			words.push({
				word: target.surface,
				start: sourceWord.start,
				end: sourceWord.end,
				confidence: exact ? sourceWord.confidence : (sourceWord.confidence ?? 1) * 0.5,
			});
		} else {
			words.push({
				word: target.surface,
				start: Number.NaN,
				end: Number.NaN,
				confidence: 0.25,
			});
		}
	}

	fillMissingTimes(words);

	const alignment: AlignmentData = {
		...source,
		text: targetText,
		segments: buildSegments(source, targetText, words),
	};

	return { alignment, similarity };
}
