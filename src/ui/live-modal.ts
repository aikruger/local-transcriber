import { App, Modal, Setting } from 'obsidian';
import LocalTranscriberPlugin from '../main';

export class LiveTranscribeModal extends Modal {
	plugin: LocalTranscriberPlugin;

	private startBtn: HTMLButtonElement;
	private pauseBtn: HTMLButtonElement;
	private stopBtn: HTMLButtonElement;
	private micSelect: HTMLSelectElement;

	private statusLabel: HTMLElement;
	private timeLabel: HTMLElement;
	private backlogLabel: HTMLElement;

	private previewBox: HTMLElement;
	private micLevelBar: HTMLElement;

	private _onStartClick: ((micId: string) => void) | null = null;
	private _onPauseClick: (() => void) | null = null;
	private _onStopClick: (() => void) | null = null;

	private audioContext: AudioContext | null = null;
	private analyser: AnalyserNode | null = null;
	private mediaStream: MediaStream | null = null;
	private drawFrame: number = 0;

	constructor(app: App, plugin: LocalTranscriberPlugin) {
		super(app);
		this.plugin = plugin;
	}

	onOpen() {
		const { contentEl } = this;
		this.titleEl.setText('Live Dictation');

		this.containerEl.style.pointerEvents = 'none';
		this.modalEl.style.pointerEvents = 'auto';
		const dimmer = this.containerEl.querySelector('.modal-bg') as HTMLElement;
		if (dimmer) dimmer.style.opacity = '0';

		const controlsDiv = contentEl.createDiv({ cls: 'live-transcribe-controls' });
		controlsDiv.style.display = 'flex';
		controlsDiv.style.gap = '10px';
		controlsDiv.style.alignItems = 'center';
		controlsDiv.style.marginBottom = '10px';

		this.micSelect = contentEl.createEl('select', { cls: 'dropdown' });
		controlsDiv.appendChild(this.micSelect);

		this.startBtn = contentEl.createEl('button', { text: 'Start' });
		this.startBtn.addClass('mod-cta');
		controlsDiv.appendChild(this.startBtn);

		this.pauseBtn = contentEl.createEl('button', { text: 'Pause' });
		this.pauseBtn.disabled = true;
		controlsDiv.appendChild(this.pauseBtn);

		this.stopBtn = contentEl.createEl('button', { text: 'Stop' });
		this.stopBtn.disabled = true;
		controlsDiv.appendChild(this.stopBtn);

		const levelContainer = contentEl.createDiv();
		levelContainer.style.width = '100%';
		levelContainer.style.height = '10px';
		levelContainer.style.backgroundColor = '#333';
		levelContainer.style.borderRadius = '5px';
		levelContainer.style.overflow = 'hidden';
		levelContainer.style.marginBottom = '10px';

		this.micLevelBar = levelContainer.createDiv();
		this.micLevelBar.style.width = '0%';
		this.micLevelBar.style.height = '100%';
		this.micLevelBar.style.backgroundColor = '#4caf50';

		const infoDiv = contentEl.createDiv();
		infoDiv.style.display = 'flex';
		infoDiv.style.flexDirection = 'column';
		infoDiv.style.gap = '5px';
		infoDiv.style.marginBottom = '10px';
		infoDiv.style.fontSize = '0.9em';
		infoDiv.style.color = 'var(--text-muted)';

		this.statusLabel = infoDiv.createDiv({ text: 'Status: Idle' });
		this.timeLabel = infoDiv.createDiv({ text: 'Time: 00:00' });
		this.backlogLabel = infoDiv.createDiv({ text: 'Backlog: 0s' });

		this.previewBox = contentEl.createDiv({ cls: 'live-transcribe-preview' });
		this.previewBox.style.minHeight = '60px';
		this.previewBox.style.maxHeight = '150px';
		this.previewBox.style.overflowY = 'auto';
		this.previewBox.style.padding = '10px';
		this.previewBox.style.border = '1px solid var(--background-modifier-border)';
		this.previewBox.style.borderRadius = '4px';
		this.previewBox.style.fontSize = '0.9em';
		this.previewBox.style.color = 'var(--text-normal)';
		this.previewBox.innerText = 'Preview of latest chunk will appear here...';

		this.populateMics();

		this.startBtn.onclick = () => {
			if (this._onStartClick) {
				const micId = this.micSelect.value;
				this._onStartClick(micId);
			}
		};

		this.pauseBtn.onclick = () => {
			if (this._onPauseClick) this._onPauseClick();
		};

		this.stopBtn.onclick = () => {
			if (this._onStopClick) this._onStopClick();
		};
	}

	async populateMics() {
		try {
			const permStream = await navigator.mediaDevices.getUserMedia({ audio: true });
			permStream.getTracks().forEach(t => t.stop());
			const devices = await navigator.mediaDevices.enumerateDevices();
			const audioInputs = devices.filter(d => d.kind === 'audioinput');
			for (const dev of audioInputs) {
				const opt = document.createElement('option');
				opt.value = dev.deviceId;
				opt.text = dev.label || `Microphone ${(this.micSelect?.options?.length || 0) + 1}`;
				this.micSelect.appendChild(opt);
			}
			if (this.plugin.settings.liveMicDeviceId) {
				this.micSelect.value = this.plugin.settings.liveMicDeviceId;
			}
		} catch (e) {
			this.log('Mic permission denied.');
		}
	}

	async startMicLevel() {
		try {
			this.mediaStream = await navigator.mediaDevices.getUserMedia({ audio: { deviceId: this.micSelect.value } });
			this.audioContext = new AudioContext();
			this.analyser = this.audioContext.createAnalyser();
			this.analyser.fftSize = 256;
			const source = this.audioContext.createMediaStreamSource(this.mediaStream);
			source.connect(this.analyser);
			this.drawMicLevel();
		} catch (e) {}
	}

	stopMicLevel() {
		cancelAnimationFrame(this.drawFrame);
		if (this.mediaStream) {
			this.mediaStream.getTracks().forEach(t => t.stop());
		}
		if (this.audioContext) {
			this.audioContext.close();
		}
		this.micLevelBar.style.width = '0%';
	}

	drawMicLevel = () => {
		if (!this.analyser) return;
		const dataArray = new Uint8Array(this.analyser.frequencyBinCount);
		this.analyser.getByteFrequencyData(dataArray);
		let sum = 0;
		for (let i = 0; i < dataArray.length; i++) sum += (dataArray[i] || 0);
		const average = sum / dataArray.length;
		const pct = Math.min(100, Math.max(0, (average / 128) * 100));
		this.micLevelBar.style.width = `${pct}%`;
		this.drawFrame = requestAnimationFrame(this.drawMicLevel);
	}

	onClose() {
		this.stopMicLevel();
		const { contentEl } = this;
		contentEl.empty();
	}

	onStartClick(cb: (micId: string) => void) { this._onStartClick = cb; }
	onPauseClick(cb: () => void) { this._onPauseClick = cb; }
	onStopClick(cb: () => void) { this._onStopClick = cb; }

	setRecordingState(state: 'idle' | 'recording' | 'paused') {
		if (state === 'recording') {
			this.startBtn.disabled = true;
			this.pauseBtn.disabled = false;
			this.stopBtn.disabled = false;
			this.micSelect.disabled = true;
			this.startMicLevel();
		} else if (state === 'paused') {
			this.startBtn.disabled = false;
			this.pauseBtn.disabled = true;
			this.stopBtn.disabled = false;
			this.stopMicLevel();
		} else {
			this.startBtn.disabled = false;
			this.pauseBtn.disabled = true;
			this.stopBtn.disabled = true;
			this.micSelect.disabled = false;
			this.stopMicLevel();
		}
	}

	log(msg: string) {
		console.log(`[Dictation UI] ${msg}`);
	}

	setPreviewText(text: string) {
		this.previewBox.innerText = text;
		this.previewBox.scrollTop = this.previewBox.scrollHeight;
	}

	setTranscriptionProgress(recordedSeconds: number, transcribedSeconds: number, isProcessing: boolean, isFinalizing: boolean) {
		const formatTime = (secs: number) => {
			const m = Math.floor(secs / 60);
			const s = Math.floor(secs % 60);
			return `${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
		};

		this.timeLabel.innerText = `Time: ${formatTime(recordedSeconds)} / ${formatTime(transcribedSeconds)}`;

		const backlog = Math.max(0, recordedSeconds - transcribedSeconds);
		this.backlogLabel.innerText = `Backlog: ${backlog.toFixed(1)}s`;

		if (isFinalizing) {
			this.statusLabel.innerText = `Status: Finalizing remaining speech`;
		} else if (isProcessing) {
			this.statusLabel.innerText = `Status: Processing`;
		} else {
			this.statusLabel.innerText = `Status: Listening`;
		}
	}
}
