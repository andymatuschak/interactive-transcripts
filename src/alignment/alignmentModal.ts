import { App, Modal, TFile } from "obsidian";
import { Aligner, AlignerOptions } from "./aligner";
import type { AlignmentData } from "../types";

/**
 * Modal that shows progress during alignment.
 */
export class AlignmentModal extends Modal {
	private progressEl: HTMLElement;
	private statusEl: HTMLElement;
	private cancelBtn: HTMLButtonElement;
	private isCancelled = false;
	private resolvePromise: ((value: AlignmentData | null) => void) | null = null;

	constructor(
		app: App,
		private audioFile: TFile,
		private transcriptText: string,
		private options: Omit<AlignerOptions, "onProgress">
	) {
		super(app);
	}

	onOpen() {
		const { contentEl } = this;
		contentEl.empty();
		contentEl.addClass("transcript-alignment-modal");

		contentEl.createEl("h2", { text: "Aligning Transcript" });

		const infoEl = contentEl.createDiv({ cls: "transcript-alignment-info" });
		infoEl.createEl("p", { text: `Audio: ${this.audioFile.name}` });
		infoEl.createEl("p", { text: `Tool: ${this.options.tool}` });
		infoEl.createEl("p", { text: `Model: ${this.options.model}` });

		this.statusEl = contentEl.createDiv({ cls: "transcript-alignment-status" });
		this.statusEl.setText("Initializing...");

		this.progressEl = contentEl.createDiv({ cls: "transcript-alignment-progress" });
		const progressBar = this.progressEl.createDiv({ cls: "transcript-progress-bar" });
		progressBar.createDiv({ cls: "transcript-progress-fill" });

		const buttonContainer = contentEl.createDiv({ cls: "transcript-alignment-buttons" });
		this.cancelBtn = buttonContainer.createEl("button", { text: "Cancel" });
		this.cancelBtn.addEventListener("click", () => {
			this.isCancelled = true;
			this.statusEl.setText("Cancelling...");
			this.cancelBtn.disabled = true;
		});
	}

	onClose() {
		const { contentEl } = this;
		contentEl.empty();
		if (this.isCancelled && this.resolvePromise) {
			this.resolvePromise(null);
		}
	}

	private updateProgress(message: string) {
		if (this.statusEl) {
			this.statusEl.setText(message);
		}
	}

	/**
	 * Run alignment and show progress.
	 */
	async runAlignment(): Promise<AlignmentData | null> {
		return new Promise(async (resolve) => {
			this.resolvePromise = resolve;
			this.open();

			const aligner = new Aligner(this.app);

			try {
				const result = await aligner.align(
					this.audioFile,
					this.transcriptText,
					{
						...this.options,
						onProgress: (message) => {
							if (!this.isCancelled) {
								this.updateProgress(message);
							}
						},
					}
				);

				if (this.isCancelled) {
					resolve(null);
				} else {
					this.updateProgress("Complete!");
					setTimeout(() => {
						this.close();
						resolve(result);
					}, 500);
				}
			} catch (err) {
				const errorMessage = err instanceof Error ? err.message : String(err);
				this.updateProgress(`Error: ${errorMessage}`);
				this.cancelBtn.setText("Close");
				this.cancelBtn.disabled = false;
				this.cancelBtn.onclick = () => {
					this.close();
					resolve(null);
				};
			}
		});
	}
}

/**
 * Run alignment with a progress modal.
 */
export async function alignWithModal(
	app: App,
	audioFile: TFile,
	transcriptText: string,
	options: Omit<AlignerOptions, "onProgress">
): Promise<AlignmentData | null> {
	const modal = new AlignmentModal(app, audioFile, transcriptText, options);
	return modal.runAlignment();
}
