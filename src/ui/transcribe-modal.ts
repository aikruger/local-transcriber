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

		new Setting(contentEl)
			.setName('Speakers')
			.setDesc('Number of speakers.')
			.addDropdown(dropdown => dropdown
				.addOption('0', 'None')
				.addOption('auto', 'Auto-detect')
				.addOption('2', '2 speakers')
				.addOption('3', '3 speakers')
				.addOption('4', '4 speakers')
				.setValue(this.selectedSpeakers)
				.onChange(value => {
					this.selectedSpeakers = value;
				})
			);

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

	onClose() {
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

	appendPreview(text: string) {
		if (this.previewArea.innerText === 'Transcript preview will appear here...') {
			this.previewArea.innerText = '';
		}
		const p = document.createElement('div');
		p.innerText = text;
		p.style.marginBottom = '5px';
		this.previewArea.appendChild(p);
		this.previewArea.scrollTop = this.previewArea.scrollHeight;
	}
}
