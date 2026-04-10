import { App, Modal, Notice, Setting } from 'obsidian';
import LocalTranscriberPlugin from '../main';

export class TranscribeModal extends Modal {
	private plugin: LocalTranscriberPlugin;
	selectedModel: string;
	selectedSpeakers: string;
	selectedInterval: number;
	selectedPauseGap: number;

	private logArea: HTMLDivElement;
	private progressBar: HTMLProgressElement;
	private progressLabel: HTMLSpanElement;
	private previewArea: HTMLDivElement;
	private runSection: HTMLDivElement;
	transcribeBtn: HTMLButtonElement;

	private _modelDropdown: any;
	private _speakerDropdown: any;
	private _intervalDropdown: any;
	private _pauseInput: any;

	public _isRunning = false;
	private _onTranscribeClick?: () => void;

	private stages = [
		{ name: 'Checking environment', pct: 5 },
		{ name: 'Installing dependencies', pct: 15 },
		{ name: 'Bootstrapping models', pct: 25 },
		{ name: 'Preparing audio', pct: 35 },
		{ name: 'Transcribing', pct: 40 },
		{ name: 'Diarizing speakers', pct: 85 },
		{ name: 'Saving outputs', pct: 95 },
		{ name: 'Done', pct: 100 },
	];

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
		contentEl.empty();
		contentEl.addClass('local-transcriber-modal');
		contentEl.createEl('h2', { text: '🔊 Transcriber' });

		const configSection = contentEl.createDiv({ cls: 'lt-config-section' });

		const models = this.plugin.settings.availableModels
			.split('\n')
			.map(m => m.trim())
			.filter(m => m.length > 0);

		if (models.length > 0) {
			new Setting(configSection)
				.setName('Model')
				.setDesc('Select Whisper model for this transcription')
				.addDropdown((dd: any) => {
					models.forEach(m => dd.addOption(m, m));
					dd.setValue(this.selectedModel);
					dd.onChange((val: string) => { this.selectedModel = val; });
					this._modelDropdown = dd;
				});
		}

		new Setting(configSection)
			.setName('Speakers')
			.setDesc('Number of speakers to identify. 0 = disable diarization.')
			.addDropdown((dd: any) => {
				['0','auto','2','3','4','6'].forEach(v =>
					dd.addOption(v, v === '0' ? 'None' : v === 'auto' ? 'Auto-detect' : `${v} speakers`)
				);
				dd.setValue(this.selectedSpeakers);
				dd.onChange((val: string) => { this.selectedSpeakers = val; });
				this._speakerDropdown = dd;
			});

		new Setting(configSection)
			.setName('Paragraph interval')
			.setDesc('Group markdown into timed paragraphs.')
			.addDropdown((dd: any) => {
				[['0','None'],['1','1 min'],['2','2 min'],['5','5 min'],['10','10 min']]
					.forEach(([v, l]) => dd.addOption(v, l));
				dd.setValue(String(this.selectedInterval));
				dd.onChange((val: string) => { this.selectedInterval = parseInt(val, 10); });
				this._intervalDropdown = dd;
			});

		new Setting(configSection)
			.setName('Pause gap (s)')
			.setDesc('Silence gap that triggers a paragraph break.')
			.addText((text: any) => {
				text.setPlaceholder('1.5').setValue(String(this.selectedPauseGap));
				text.inputEl.style.width = '60px';
				text.onChange((val: string) => { this.selectedPauseGap = parseFloat(val) || 1.5; });
				this._pauseInput = text;
			});

		const btnRow = contentEl.createDiv({ cls: 'lt-btn-row' });
		this.transcribeBtn = btnRow.createEl('button', {
			text: '▶ Start Transcription',
			cls: 'mod-cta lt-transcribe-btn',
		});
		this.transcribeBtn.addEventListener('click', () => {
			if (this._onTranscribeClick) this._onTranscribeClick();
		});

		this.runSection = contentEl.createDiv({ cls: 'lt-run-section lt-hidden' });

		const progressRow = this.runSection.createDiv({ cls: 'lt-progress-row' });
		this.progressLabel = progressRow.createEl('span', {
			cls: 'lt-progress-label',
			text: 'Waiting...',
		});
		this.progressBar = progressRow.createEl('progress');
		this.progressBar.max = 100;
		this.progressBar.value = 0;
		this.progressBar.addClass('lt-progress-bar');

		this.runSection.createEl('h4', { text: 'Log' });
		this.logArea = this.runSection.createDiv({ cls: 'lt-log-area' });

		this.runSection.createEl('h4', { text: 'Live Transcript Preview' });
		this.previewArea = this.runSection.createDiv({ cls: 'lt-preview-area' });
	}

	onTranscribeClick(callback: () => void) {
		this._onTranscribeClick = callback;
	}

	startRunning() {
		this._isRunning = true;
		this.modalEl.addClass('lt-locked');

		[this._modelDropdown, this._speakerDropdown, this._intervalDropdown]
			.forEach(dd => { if (dd) dd.selectEl.disabled = true; });
		if (this._pauseInput) this._pauseInput.inputEl.disabled = true;

		this.transcribeBtn.textContent = '⏳ Transcribing...';
		this.transcribeBtn.disabled = true;
		this.runSection.removeClass('lt-hidden');
	}

	setStage(stageName: string) {
		const stage = this.stages.find(s => s.name === stageName);
		if (!stage) return;
		this.progressBar.value = stage.pct;
		this.progressLabel.textContent = stage.name + '...';

		const longStages = ['Bootstrapping models', 'Transcribing', 'Diarizing speakers'];
		if (longStages.includes(stageName)) {
			this.progressBar.addClass('lt-progress-indeterminate');
		} else {
			this.progressBar.removeClass('lt-progress-indeterminate');
		}
	}

	setProgress(pct: number) {
		this.progressBar.value = Math.min(Math.max(pct, 0), 100);
	}

	log(text: string) {
		if (!this.logArea) return;
		this.logArea.createEl('div', { cls: 'lt-log-line', text });
		this.logArea.scrollTop = this.logArea.scrollHeight;
	}

	appendPreview(line: string) {
		if (!this.previewArea) return;
		this.previewArea.createEl('div', { cls: 'lt-preview-line', text: line });
		this.previewArea.scrollTop = this.previewArea.scrollHeight;
	}

	close() {
		if (this._isRunning) {
			new Notice('Transcription in progress. Please wait until it finishes.');
			return;
		}
		super.close();
	}

	onClose() {
		this.contentEl.empty();
	}
}
