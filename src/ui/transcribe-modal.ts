import { App, Modal, Setting } from 'obsidian';
import LocalTranscriberPlugin from '../main';

export class TranscribeModal extends Modal {
	plugin: LocalTranscriberPlugin;

	selectedModel: string;
	selectedSpeakers: string;
	selectedInterval: number;
	selectedPauseGap: number;

	transcribeBtn: HTMLButtonElement;
	progressBar: HTMLElement;
	logArea: HTMLElement;
	previewArea: HTMLElement;

	private _onTranscribeClick: (() => void) | null = null;
	public _isRunning = false;

	private timerInterval: number | null = null;
	private startTime: number | null = null;
	private timerEl: HTMLElement;
	public estimatedDuration: number = 0;

	constructor(app: App, plugin: LocalTranscriberPlugin) {
		super(app);
		this.plugin = plugin;
		this.selectedModel = plugin.settings.modelSize;
		this.selectedSpeakers = plugin.settings.speakers;
		this.selectedInterval = plugin.settings.markdownInterval;
		this.selectedPauseGap = plugin.settings.markdownPauseGap;
	}

	onOpen() {
		const { contentEl } = this;
		this.titleEl.setText('Transcribe Audio/Video');

		const fileModels = this.plugin.modelRegistry.getModelsByMode("file");

		new Setting(contentEl)
			.setName('Model')
			.setDesc('Select the transcription model.')
			.addDropdown(dropdown => {
				fileModels.forEach(m => dropdown.addOption(`${m.backend}::${m.id}`, m.label));
				dropdown.setValue(this.selectedModel);
				dropdown.onChange(value => {
					this.selectedModel = value;
				});
			});

		let customSpeakerInput: HTMLInputElement | null = null;

		new Setting(contentEl)
			.setName('Speakers')
			.setDesc('Number of speakers for diarization. Choose auto-detect or enter a custom count.')
			.addDropdown(dropdown => {
				dropdown
					.addOption('0', 'None (no diarization)')
					.addOption('auto', 'Auto-detect')
					.addOption('2', '2 speakers')
					.addOption('3', '3 speakers')
					.addOption('4', '4 speakers')
					.addOption('5', '5 speakers')
					.addOption('custom', 'Custom...')
					.setValue(
						['0','auto','2','3','4','5'].includes(this.selectedSpeakers)
							? this.selectedSpeakers
							: 'custom'
					)
					.onChange(value => {
						console.log(`[TranscribeModal] Speakers dropdown changed to: ${value}`);
						if (value === 'custom') {
							if (customSpeakerInput) customSpeakerInput.style.display = 'inline-block';
						} else {
							this.selectedSpeakers = value;
							if (customSpeakerInput) customSpeakerInput.style.display = 'none';
						}
					});
			})
			.addText(t => {
				customSpeakerInput = t.inputEl;
				t.setPlaceholder('e.g. 6')
					.setValue(
						['0','auto','2','3','4','5'].includes(this.selectedSpeakers) ? '' : this.selectedSpeakers
					)
					.onChange(value => {
						const n = parseInt(value);
						if (!isNaN(n) && n > 0) {
							this.selectedSpeakers = String(n);
							console.log(`[TranscribeModal] Custom speaker count set to: ${this.selectedSpeakers}`);
						}
					});
				t.inputEl.style.width = '60px';
				// Hide unless 'custom' is already selected
				t.inputEl.style.display = (
					['0','auto','2','3','4','5'].includes(this.selectedSpeakers) ? 'none' : 'inline-block'
				);
			});

		const controlsDiv = contentEl.createDiv({ cls: 'transcribe-modal-controls' });
		controlsDiv.style.marginTop = '20px';
		controlsDiv.style.textAlign = 'right';

		this.transcribeBtn = controlsDiv.createEl('button', { text: 'Transcribe' });
		this.transcribeBtn.addClass('mod-cta');
		this.transcribeBtn.onclick = () => {
			if (!this._isRunning && this._onTranscribeClick) {
				this._onTranscribeClick();
			}
		};

		const progressDiv = contentEl.createDiv();
		progressDiv.style.marginTop = '20px';
		progressDiv.style.height = '10px';
		progressDiv.style.backgroundColor = 'var(--background-modifier-border)';
		progressDiv.style.borderRadius = '5px';
		progressDiv.style.overflow = 'hidden';

		this.progressBar = progressDiv.createDiv();
		this.progressBar.style.height = '100%';
		this.progressBar.style.width = '0%';
		this.progressBar.style.backgroundColor = 'var(--interactive-accent)';
		this.progressBar.style.transition = 'width 0.2s ease-in-out';

		this.timerEl = contentEl.createDiv({ cls: 'transcribe-timer' });
		this.timerEl.style.marginTop = '8px';
		this.timerEl.style.fontSize = '0.85em';
		this.timerEl.style.color = 'var(--text-muted)';
		this.timerEl.style.fontVariantNumeric = 'tabular-nums';
		this.timerEl.innerText = '';
		console.log('[TranscribeModal] Timer element created');

		this.logArea = contentEl.createEl('div');
		this.logArea.style.marginTop = '10px';
		this.logArea.style.fontSize = '0.9em';
		this.logArea.style.color = 'var(--text-muted)';
		this.logArea.innerText = 'Ready.';

		this.previewArea = contentEl.createEl('div');
		this.previewArea.style.marginTop = '20px';
		this.previewArea.style.padding = '10px';
		this.previewArea.style.border = '1px solid var(--background-modifier-border)';
		this.previewArea.style.borderRadius = '5px';
		this.previewArea.style.minHeight = '100px';
		this.previewArea.style.maxHeight = '200px';
		this.previewArea.style.overflowY = 'auto';
		this.previewArea.style.fontSize = '0.9em';
		this.previewArea.innerText = 'Transcript preview will appear here...';
	}

	stopTimer() {
		if (this.timerInterval !== null) {
			window.clearInterval(this.timerInterval);
			this.timerInterval = null;
			console.log('[TranscribeModal] Timer stopped');
		}
	}

	onClose() {
		this.stopTimer();
		const { contentEl } = this;
		contentEl.empty();
	}

	onTranscribeClick(cb: () => void) {
		this._onTranscribeClick = cb;
	}

	startRunning() {
		this._isRunning = true;
		this.transcribeBtn.disabled = true;
		this.transcribeBtn.textContent = 'Transcribing...';
		this.setProgress(0);
		this.previewArea.innerText = '';

		// ✅ Start elapsed timer
		this.startTime = Date.now();
		console.log('[TranscribeModal] Timer started');
		this.timerInterval = window.setInterval(() => {
			if (!this.startTime) return;
			const elapsed = Math.floor((Date.now() - this.startTime) / 1000);
			const m = Math.floor(elapsed / 60).toString().padStart(2, '0');
			const s = (elapsed % 60).toString().padStart(2, '0');
			let label = `⏱ Elapsed: ${m}:${s}`;

			// Show estimated remaining if we have audio duration
			if (this.estimatedDuration > 0) {
				const pct = parseFloat(this.progressBar.style.width) / 100;
				if (pct > 0.05) {
					const totalEstSec = Math.floor(elapsed / pct);
					const remainSec = Math.max(0, totalEstSec - elapsed);
					const rm = Math.floor(remainSec / 60).toString().padStart(2, '0');
					const rs = (remainSec % 60).toString().padStart(2, '0');
					label += `  |  ⏳ ~${rm}:${rs} remaining`;
				}
			}

			this.timerEl.innerText = label;
			console.log(`[TranscribeModal] Timer tick: ${label}`);
		}, 1000);
	}

	setStage(stage: string) {
		this.logArea.innerText = stage + '...';
	}

	log(msg: string) {
		this.logArea.innerText = msg;
	}

	setProgress(percent: number) {
		this.progressBar.style.width = `${Math.max(0, Math.min(100, percent))}%`;
	}

	appendPreview(text: string, speaker: string | null = null) {
		if (this.previewArea.innerText === 'Transcript preview will appear here...') {
			this.previewArea.innerText = '';
		}

		const p = document.createElement('div');
		p.innerText = text;
		p.style.marginBottom = '4px';
		p.style.paddingLeft = '8px';
		p.style.borderRadius = '2px';

		// Assign a distinct colour per speaker using CSS accent variables
		const speakerColors: Record<string, string> = {
			'SPEAKER_00': 'var(--color-blue)',
			'SPEAKER_01': 'var(--color-green)',
			'SPEAKER_02': 'var(--color-orange)',
			'SPEAKER_03': 'var(--color-purple)',
			'SPEAKER_04': 'var(--color-pink)',
		};

		if (speaker && speakerColors[speaker]) {
			p.style.borderLeft = `3px solid ${speakerColors[speaker]}`;
			console.log(`[TranscribeModal] appendPreview — speaker="${speaker}", color applied`);
		} else {
			p.style.borderLeft = '3px solid var(--background-modifier-border)';
		}

		this.previewArea.appendChild(p);
		this.previewArea.scrollTop = this.previewArea.scrollHeight;
	}
}
