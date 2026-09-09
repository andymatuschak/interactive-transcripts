import {
	MarkdownRenderer,
	MarkdownRenderChild,
	setIcon,
	type App,
	type MarkdownPostProcessorContext,
} from "obsidian";
import { AlignmentManager, type AlignmentProgress } from "./alignment/alignmentManager";
import { alignmentStore } from "./alignment/alignmentStore";
import { parseTranscriptDirectives } from "./core/parser";
import { PlayButtonWidget } from "./editor/widgets";
import { AudioManager, type PlaybackState } from "./playback/audioManager";
import type { AlignedWord, TranscriptDirective } from "./types";

const SKIP_REGEX = /:skip\{start=([\d.]+)\s+end=([\d.]+)\}/g;

interface SkipToken {
	token: string;
	start: number;
	end: number;
}

function isMacPlatform(): boolean {
	return navigator.platform.toLowerCase().includes("mac");
}

function isSeekModifierPressed(event: MouseEvent): boolean {
	return isMacPlatform() ? event.metaKey : event.ctrlKey;
}

function isModifierKey(event: KeyboardEvent): boolean {
	return event.key === (isMacPlatform() ? "Meta" : "Control");
}

function hasClosingFence(element: HTMLElement): boolean {
	return (element.textContent ?? "")
		.split(/\r?\n/)
		.some((line) => line.trim() === ":::");
}

function getOpeningLine(source: string, directive: TranscriptDirective): string {
	const lineEnd = source.indexOf("\n", directive.from);
	return source.slice(
		directive.from,
		lineEnd === -1 ? source.length : lineEnd
	);
}

function findDirectiveForOpeningElement(
	source: string,
	directives: TranscriptDirective[],
	element: HTMLElement
): { directive: TranscriptDirective; openingLine: string } | null {
	const elementText = element.textContent ?? "";
	const matching = directives
		.map((directive) => ({
			directive,
			openingLine: getOpeningLine(source, directive),
		}))
		.filter(({ openingLine }) => elementText.includes(openingLine));
	if (matching.length === 0) return null;

	const openingLine = matching[0]!.openingLine;
	const sameOpeningLine = matching.filter(
		(candidate) => candidate.openingLine === openingLine
	);
	const siblings = Array.from(element.parentElement?.children ?? []);
	const elementIndex = siblings.indexOf(element);
	const occurrence = siblings
		.slice(0, elementIndex + 1)
		.filter(
			(sibling) =>
				(sibling as HTMLElement).dataset.transcriptOpening === openingLine ||
				(sibling.textContent ?? "").includes(openingLine)
		).length - 1;

	return sameOpeningLine[occurrence] ?? sameOpeningLine[0] ?? null;
}

function prepareContent(content: string): {
	markdown: string;
	tokens: SkipToken[];
} {
	const tokens: SkipToken[] = [];
	SKIP_REGEX.lastIndex = 0;
	const markdown = content.replace(SKIP_REGEX, (_match, startText, endText) => {
		const token = `TRANSCRIPT_SKIP_${tokens.length}_PLACEHOLDER`;
		tokens.push({
			token,
			start: Number.parseFloat(startText),
			end: Number.parseFloat(endText),
		});
		return token;
	});
	return { markdown, tokens };
}

function replaceSkipTokens(root: HTMLElement, tokens: SkipToken[]): void {
	if (tokens.length === 0) return;

	const tokenByText = new Map(tokens.map((token) => [token.token, token]));
	const textNodes: Text[] = [];
	const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
	let current = walker.nextNode();
	while (current) {
		textNodes.push(current as Text);
		current = walker.nextNode();
	}

	for (const textNode of textNodes) {
		const source = textNode.data;
		const matches: Array<{ index: number; token: SkipToken }> = [];
		for (const [tokenText, token] of tokenByText) {
			const index = source.indexOf(tokenText);
			if (index !== -1) matches.push({ index, token });
		}
		if (matches.length === 0) continue;

		matches.sort((a, b) => a.index - b.index);
		const fragment = document.createDocumentFragment();
		let cursor = 0;
		for (const match of matches) {
			fragment.append(source.slice(cursor, match.index));
			const marker = document.createElement("span");
			marker.className = "transcript-skip-marker";
			marker.textContent = "\u22ee";
			marker.title = `Skipped: ${match.token.start.toFixed(1)}s - ${match.token.end.toFixed(1)}s`;
			fragment.append(marker);
			cursor = match.index + match.token.token.length;
		}
		fragment.append(source.slice(cursor));
		textNode.replaceWith(fragment);
	}
}

function findPlaybackWordIndex(words: AlignedWord[], time: number): number | null {
	let previousIndex = -1;
	let nextIndex = -1;

	for (let index = 0; index < words.length; index++) {
		const word = words[index];
		if (!word) continue;
		if (time >= word.start && time <= word.end) return index;
		if (time > word.end) previousIndex = index;
		if (time < word.start && nextIndex === -1) nextIndex = index;
	}

	if (previousIndex === -1) return null;
	const previous = words[previousIndex];
	const next = nextIndex === -1 ? null : words[nextIndex];
	if (!previous) return null;

	return !next || next.start - previous.end < 1 ? previousIndex : null;
}

interface TextSegment {
	node: Text;
	from: number;
	to: number;
}

interface WordRange {
	index: number;
	from: number;
	to: number;
}

function decorateAlignedWords(
	root: HTMLElement,
	words: AlignedWord[]
): Map<number, HTMLElement[]> {
	const segments: TextSegment[] = [];
	let combinedText = "";
	const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
		acceptNode(node) {
			const parent = (node as Text).parentElement;
			return parent?.closest(".transcript-skip-marker")
				? NodeFilter.FILTER_REJECT
				: NodeFilter.FILTER_ACCEPT;
		},
	});

	let current = walker.nextNode();
	while (current) {
		const node = current as Text;
		const from = combinedText.length;
		combinedText += node.data;
		segments.push({ node, from, to: combinedText.length });
		current = walker.nextNode();
	}

	const ranges: WordRange[] = [];
	let searchFrom = 0;
	for (let index = 0; index < words.length; index++) {
		const wordText = words[index]?.word.trim();
		if (!wordText) continue;
		const from = combinedText.indexOf(wordText, searchFrom);
		if (from === -1) continue;
		const to = from + wordText.length;
		ranges.push({ index, from, to });
		searchFrom = to;
	}

	const elements = new Map<number, HTMLElement[]>();
	for (const segment of segments) {
		const intersections = ranges.filter(
			(range) => range.from < segment.to && range.to > segment.from
		);
		if (intersections.length === 0) continue;

		const fragment = document.createDocumentFragment();
		let cursor = 0;
		for (const range of intersections) {
			const localFrom = Math.max(0, range.from - segment.from);
			const localTo = Math.min(segment.node.data.length, range.to - segment.from);
			fragment.append(segment.node.data.slice(cursor, localFrom));

			const span = document.createElement("span");
			span.className = "transcript-reading-word";
			span.dataset.wordIndex = String(range.index);
			span.textContent = segment.node.data.slice(localFrom, localTo);
			fragment.append(span);

			const existing = elements.get(range.index) ?? [];
			existing.push(span);
			elements.set(range.index, existing);
			cursor = localTo;
		}
		fragment.append(segment.node.data.slice(cursor));
		segment.node.replaceWith(fragment);
	}

	return elements;
}

class ReadingPlaybackControls {
	private readonly container: HTMLElement;
	private readonly playPauseButton: HTMLButtonElement;
	private readonly currentTime: HTMLElement;
	private readonly duration: HTMLElement;
	private readonly scrubber: HTMLInputElement;
	private isDragging = false;

	constructor(
		parent: HTMLElement,
		private readonly audioManager: AudioManager
	) {
		this.container = document.createElement("div");
		this.container.className =
			"transcript-floating-controls transcript-reading-controls";

		this.playPauseButton = document.createElement("button");
		this.playPauseButton.className =
			"transcript-control-btn transcript-play-pause";
		this.playPauseButton.ariaLabel = "Play/Pause";
		this.playPauseButton.addEventListener("click", this.handlePlayPause);
		this.container.append(this.playPauseButton);

		this.currentTime = document.createElement("span");
		this.currentTime.className = "transcript-time-display";
		this.currentTime.textContent = "0:00";
		this.container.append(this.currentTime);

		this.scrubber = document.createElement("input");
		this.scrubber.type = "range";
		this.scrubber.className = "transcript-scrubber";
		this.scrubber.min = "0";
		this.scrubber.max = "1000";
		this.scrubber.value = "0";
		this.scrubber.addEventListener("input", this.handleScrubberInput);
		this.scrubber.addEventListener("change", this.handleScrubberChange);
		this.container.append(this.scrubber);

		this.duration = document.createElement("span");
		this.duration.className = "transcript-time-display";
		this.duration.textContent = "0:00";
		this.container.append(this.duration);

		const closeButton = document.createElement("button");
		closeButton.className = "transcript-control-btn transcript-close";
		closeButton.ariaLabel = "Stop";
		setIcon(closeButton, "x");
		closeButton.addEventListener("click", this.handleStop);
		this.container.append(closeButton);

		parent.append(this.container);
		this.update(this.audioManager.getState(), false);
	}

	update(state: PlaybackState, ownsPlayback: boolean): void {
		this.container.classList.toggle("is-visible", ownsPlayback);
		if (!ownsPlayback) return;

		this.playPauseButton.replaceChildren();
		setIcon(this.playPauseButton, state.isPlaying ? "pause" : "play");
		if (!this.isDragging && state.duration > 0) {
			this.scrubber.value = String(
				(state.currentTime / state.duration) * 1000
			);
		}
		const percent =
			state.duration > 0 ? (state.currentTime / state.duration) * 100 : 0;
		this.scrubber.style.background =
			`linear-gradient(to right, var(--interactive-accent) ${percent}%, ` +
			`var(--background-modifier-border) ${percent}%)`;
		this.currentTime.textContent = this.formatTime(state.currentTime);
		this.duration.textContent = this.formatTime(state.duration);
	}

	destroy(): void {
		this.playPauseButton.removeEventListener("click", this.handlePlayPause);
		this.scrubber.removeEventListener("input", this.handleScrubberInput);
		this.scrubber.removeEventListener("change", this.handleScrubberChange);
		this.container
			.querySelector(".transcript-close")
			?.removeEventListener("click", this.handleStop);
		this.container.remove();
	}

	private formatTime(seconds: number): string {
		if (!Number.isFinite(seconds)) return "0:00";
		const minutes = Math.floor(seconds / 60);
		const remainder = Math.floor(seconds % 60);
		return `${minutes}:${remainder.toString().padStart(2, "0")}`;
	}

	private readonly handlePlayPause = (): void => {
		this.audioManager.togglePlayPause();
	};

	private readonly handleStop = (): void => {
		this.audioManager.stop();
	};

	private readonly handleScrubberInput = (): void => {
		this.isDragging = true;
		const state = this.audioManager.getState();
		this.audioManager.seekTo(
			(Number.parseFloat(this.scrubber.value) / 1000) * state.duration
		);
	};

	private readonly handleScrubberChange = (): void => {
		this.isDragging = false;
	};
}

class ReadingTranscriptChild extends MarkdownRenderChild {
	private readonly contentEl: HTMLElement;
	private readonly audioManager = AudioManager.getInstance();
	private readonly alignmentManager = AlignmentManager.getInstance();
	private playButton: PlayButtonWidget | null = null;
	private playbackControls: ReadingPlaybackControls | null = null;
	private audioUnsubscribe: (() => void) | null = null;
	private alignmentUnsubscribe: (() => void) | null = null;
	private finderUnsubscribe: (() => void) | null = null;
	private words: AlignedWord[] = [];
	private wordElements = new Map<number, HTMLElement[]>();
	private contentRendered = false;
	private hoveredWordIndex: number | null = null;
	private commandHoverIndex: number | null = null;
	private playbackWordIndex: number | null = null;
	private modifierPressed = false;

	constructor(
		containerEl: HTMLElement,
		private readonly app: App,
		private readonly directive: TranscriptDirective,
		private readonly markdownContent: string,
		private readonly sourcePath: string,
		private readonly documentDirectives: TranscriptDirective[]
	) {
		super(containerEl);
		this.contentEl = document.createElement("div");
		this.contentEl.className = "transcript-reading-content";
		containerEl.append(this.contentEl);
	}

	onload(): void {
		this.playButton = new PlayButtonWidget(this.directive);
		this.containerEl.prepend(this.playButton.toDOM());
		this.playbackControls = new ReadingPlaybackControls(
			this.containerEl,
			this.audioManager
		);

		this.containerEl.addEventListener("mousemove", this.handleMouseMove);
		this.containerEl.addEventListener("mouseleave", this.handleMouseLeave);
		this.containerEl.addEventListener("click", this.handleClick);
		window.addEventListener("keydown", this.handleKeyDown);
		window.addEventListener("keyup", this.handleKeyUp);
		window.addEventListener("blur", this.handleWindowBlur);

		this.audioUnsubscribe = this.audioManager.subscribe((state) => {
			this.updatePlaybackHighlight(state);
		});
		this.alignmentUnsubscribe = this.alignmentManager.subscribeToStatus(
			(audioPath, progress) => {
				if (audioPath !== this.directive.audioPath) return;
				this.updateAlignmentStatus(progress);
				if (progress.status === "complete") this.tryDecorateWords();
			}
		);
		this.finderUnsubscribe = this.audioManager.addNextDirectiveFinder(
			(current) => this.findNextDirective(current)
		);

		this.updateAlignmentStatus(
			this.alignmentManager.getProgress(this.directive.audioPath)
		);
		this.updatePlaybackHighlight(this.audioManager.getState());
		void this.renderContent();
		void this.alignmentManager
			.requestAlignment(this.directive)
			.then(() => this.tryDecorateWords());
	}

	onunload(): void {
		if (this.audioManager.isCurrentDirective(this.directive)) {
			this.audioManager.stop();
		}
		this.playButton?.destroy();
		this.playbackControls?.destroy();
		this.audioUnsubscribe?.();
		this.alignmentUnsubscribe?.();
		this.finderUnsubscribe?.();
		this.containerEl.removeEventListener("mousemove", this.handleMouseMove);
		this.containerEl.removeEventListener("mouseleave", this.handleMouseLeave);
		this.containerEl.removeEventListener("click", this.handleClick);
		window.removeEventListener("keydown", this.handleKeyDown);
		window.removeEventListener("keyup", this.handleKeyUp);
		window.removeEventListener("blur", this.handleWindowBlur);
	}

	private async renderContent(): Promise<void> {
		const { markdown, tokens } = prepareContent(this.markdownContent);
		await MarkdownRenderer.render(
			this.app,
			markdown,
			this.contentEl,
			this.sourcePath,
			this
		);
		if (!this.containerEl.isConnected) return;
		replaceSkipTokens(this.contentEl, tokens);
		this.contentRendered = true;
		this.tryDecorateWords();
	}

	private tryDecorateWords(): void {
		if (!this.contentRendered || this.wordElements.size > 0) return;
		this.words = alignmentStore.getWords(
			this.directive.audioPath,
			this.directive.content
		);
		if (this.words.length === 0) return;
		this.wordElements = decorateAlignedWords(this.contentEl, this.words);
		this.updatePlaybackHighlight(this.audioManager.getState());
	}

	private updateAlignmentStatus(progress: AlignmentProgress): void {
		this.containerEl.classList.toggle(
			"transcript-aligning",
			progress.status === "pending" || progress.status === "generating"
		);
	}

	private findNextDirective(
		current: TranscriptDirective
	): TranscriptDirective | null {
		if (current.sourcePath !== this.sourcePath) return null;
		const sameAudio = this.documentDirectives.filter(
			(candidate) => candidate.audioPath === current.audioPath
		);
		const index = sameAudio.findIndex(
			(candidate) =>
				candidate.from === current.from && candidate.content === current.content
		);
		return index === -1 ? null : (sameAudio[index + 1] ?? null);
	}

	private updatePlaybackHighlight(state: PlaybackState): void {
		this.playbackControls?.update(
			state,
			this.audioManager.isCurrentDirective(this.directive)
		);
		const nextIndex =
			state.isPlaying && this.audioManager.isCurrentDirective(this.directive)
				? findPlaybackWordIndex(this.words, state.currentTime)
				: null;
		if (nextIndex === this.playbackWordIndex) return;

		this.setWordClass(this.playbackWordIndex, "transcript-word-highlight", false);
		this.playbackWordIndex = nextIndex;
		this.setWordClass(nextIndex, "transcript-word-highlight", true);
		if (nextIndex !== null) {
			this.wordElements.get(nextIndex)?.[0]?.scrollIntoView({
				block: "nearest",
				behavior: "smooth",
			});
		}
	}

	private readonly handleMouseMove = (event: MouseEvent): void => {
		const target = event.target instanceof Element
			? event.target.closest<HTMLElement>(".transcript-reading-word")
			: null;
		this.hoveredWordIndex = target && this.contentEl.contains(target)
			? Number.parseInt(target.dataset.wordIndex ?? "", 10)
			: null;
		if (
			this.hoveredWordIndex !== null &&
			Number.isNaN(this.hoveredWordIndex)
		) {
			this.hoveredWordIndex = null;
		}
		this.modifierPressed = isSeekModifierPressed(event);
		this.updateCommandHover();
	};

	private readonly handleMouseLeave = (): void => {
		this.hoveredWordIndex = null;
		this.updateCommandHover();
	};

	private readonly handleClick = (event: MouseEvent): void => {
		if (!isSeekModifierPressed(event)) return;
		const target = event.target instanceof Element
			? event.target.closest<HTMLElement>(".transcript-reading-word")
			: null;
		if (!target || !this.contentEl.contains(target)) return;
		const index = Number.parseInt(target.dataset.wordIndex ?? "", 10);
		const word = this.words[index];
		if (!word) return;
		event.preventDefault();
		event.stopPropagation();
		void this.audioManager.play(this.directive, word.start);
	};

	private readonly handleKeyDown = (event: KeyboardEvent): void => {
		if (!isModifierKey(event)) return;
		this.modifierPressed = true;
		this.updateCommandHover();
	};

	private readonly handleKeyUp = (event: KeyboardEvent): void => {
		if (!isModifierKey(event)) return;
		this.modifierPressed = false;
		this.updateCommandHover();
	};

	private readonly handleWindowBlur = (): void => {
		this.modifierPressed = false;
		this.updateCommandHover();
	};

	private updateCommandHover(): void {
		const nextIndex = this.modifierPressed ? this.hoveredWordIndex : null;
		if (nextIndex === this.commandHoverIndex) return;
		this.setWordClass(this.commandHoverIndex, "transcript-command-hover", false);
		this.commandHoverIndex = nextIndex;
		this.setWordClass(nextIndex, "transcript-command-hover", true);
	}

	private setWordClass(
		index: number | null,
		className: string,
		enabled: boolean
	): void {
		if (index === null) return;
		for (const element of this.wordElements.get(index) ?? []) {
			element.classList.toggle(className, enabled);
		}
	}
}

function findClosingElement(start: HTMLElement): HTMLElement | null {
	let current: HTMLElement | null = start;
	while (current) {
		if (hasClosingFence(current)) return current;
		current = current.nextElementSibling as HTMLElement | null;
	}
	return null;
}

function getRawDirectiveContent(
	source: string,
	directive: TranscriptDirective
): string {
	return source
		.slice(directive.contentFrom, directive.to)
		.replace(/\r?\n:::\s*$/, "");
}

function consumeRenderedRange(
	start: HTMLElement,
	end: HTMLElement,
	transcriptEl: HTMLElement
): void {
	let current: HTMLElement | null = start;
	while (current) {
		const nextElement = current.nextElementSibling as HTMLElement | null;
		if (current === start) {
			current.replaceChildren(transcriptEl);
			current.classList.add("transcript-reading-host");
		} else {
			current.replaceChildren();
			current.classList.add("transcript-reading-consumed");
		}
		if (current === end) return;
		current = nextElement;
	}
}

/** Render transcript directives as interactive, read-only blocks in Reading Mode. */
export async function processReadingTranscripts(
	app: App,
	container: HTMLElement,
	context: MarkdownPostProcessorContext
): Promise<void> {
	if (container.closest(".transcript-reading-block")) return;
	if (!(container.textContent ?? "").includes(":::transcript[")) return;
	const sourceFile = app.vault.getFileByPath(context.sourcePath);
	if (!sourceFile) return;

	const source = await app.vault.cachedRead(sourceFile);
	if (!container.parentElement) return;
	const documentDirectives = parseTranscriptDirectives(source);
	const match = findDirectiveForOpeningElement(
		source,
		documentDirectives,
		container
	);
	if (!match) return;
	const closingElement = findClosingElement(container);
	if (!closingElement) return;

	const directivesWithSource = documentDirectives.map((directive) => ({
		...directive,
		sourcePath: context.sourcePath,
	}));
	const documentDirective = directivesWithSource.find(
		(candidate) => candidate.from === match.directive.from
	) ?? { ...match.directive, sourcePath: context.sourcePath };

	const transcriptEl = document.createElement("div");
	transcriptEl.className = "transcript-reading-block";
	transcriptEl.dataset.transcriptOpening = match.openingLine;
	container.dataset.transcriptOpening = match.openingLine;
	consumeRenderedRange(container, closingElement, transcriptEl);
	context.addChild(
		new ReadingTranscriptChild(
			transcriptEl,
			app,
			documentDirective,
			getRawDirectiveContent(source, match.directive),
			context.sourcePath,
			directivesWithSource
		)
	);
}
