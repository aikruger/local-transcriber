import { App, Modal, Notice, Setting, TFile } from 'obsidian';
import LocalTranscriberPlugin from '../main';
import { LiveTranscriptionSession, LiveSegment } from '../live-session';

export class LiveTranscribeModal extends Modal {
	private plugin: LocalTranscriberPlugin;

	// UI Elements
	private startBtn: HTMLButtonElement;
	private pauseBtn: HTMLButtonElement;
	private stopBtn: HTMLButtonElement;
	private levelMeter: HTMLMeterElement;
	private timerLabel: HTMLSpanElement;
	private previewArea: HTMLDivElement;
	private _micDropdown: any;

	private mediaStream: MediaStream | null = null;
	private audioContext: AudioContext | null = null;
	private analyser: AnalyserNode | null = null;
	private meterInterval: number | null = null;

	private elapsedSeconds: number = 0;
	private timerInterval: any = null;

	private _onStartClick?: (micId: string) => void;
	private _onPauseClick?: () => void;
	private _onStopClick?: () => void;

	constructor(app: App, plugin: LocalTranscriberPlugin) {
		super(app);
		this.plugin = plugin;
	}

	async onOpen() {
		const { contentEl } = this;
		contentEl.empty();
		contentEl.addClass('local-transcriber-modal', 'lt-compact-modal');

		// Remove locked state - modal shouldn't trap focus for dictation
		this.modalEl.removeClass('lt-locked');

		const headerRow = contentEl.createDiv({ cls: 'lt-dictation-header' });
		headerRow.createEl('h3', { text: '🎙 Dictation', cls: 'lt-dictation-title' });

		const configSection = contentEl.createDiv({ cls: 'lt-config-section' });

		new Setting(configSection)
			.setName('Microphone')
			.addDropdown((dd: any) => {
				this._micDropdown = dd;
				navigator.mediaDevices.enumerateDevices().then(devices => {
					const audioInputs = devices.filter(d => d.kind === 'audioinput');
					audioInputs.forEach(d => {
						dd.addOption(d.deviceId, d.label || `Microphone ${d.deviceId.substring(0, 5)}...`);
					});
					if (audioInputs.length > 0) {
						let deviceId = this.plugin.settings.liveMicDeviceId;
						if (!audioInputs.find(d => d.deviceId === deviceId)) {
							const id = audioInputs[0]?.deviceId;
							if (id) deviceId = id;
						}
						if (deviceId) dd.setValue(deviceId);
					}
				}).catch(e => {
					console.error("Failed to list microphones", e);
				});

				dd.onChange(async (val: string) => {
					this.plugin.settings.liveMicDeviceId = val;
					await this.plugin.saveSettings();
					this.setupLevelMeter(val);
				});
			});

		// Level Meter
		const meterRow = configSection.createDiv({ cls: 'lt-meter-row' });
		meterRow.createEl('span', { text: 'Level: ', cls: 'lt-meter-label' });
		this.levelMeter = meterRow.createEl('meter', { cls: 'lt-level-meter' });
		this.levelMeter.min = -60;
		this.levelMeter.max = 0;
		this.levelMeter.value = -60;
		this.levelMeter.low = -20;
		this.levelMeter.high = -5;
		this.levelMeter.optimum = -10;

		const timerRow = configSection.createDiv({ cls: 'lt-timer-row' });
		this.timerLabel = timerRow.createEl('span', { text: '00:00', cls: 'lt-timer-label' });

		const previewRow = configSection.createDiv({ cls: 'lt-dictation-preview', attr: {style: 'margin-top: 10px; font-style: italic; color: var(--text-muted);'} });
		this.previewArea = previewRow.createEl('div', { text: 'Waiting for speech...' });

		const btnRow = contentEl.createDiv({ cls: 'lt-btn-row' });
		this.startBtn = btnRow.createEl('button', {
			text: '▶ Start',
			cls: 'mod-cta lt-transcribe-btn',
		});
		this.startBtn.addEventListener('click', () => {
			if (this._onStartClick) {
				const micId = this._micDropdown.getValue();
				this._onStartClick(micId);
			}
		});

		this.pauseBtn = btnRow.createEl('button', {
			text: '⏸ Pause',
			cls: 'lt-transcribe-btn lt-hidden',
		});
		this.pauseBtn.addEventListener('click', () => {
			if (this._onPauseClick) this._onPauseClick();
		});

		this.stopBtn = btnRow.createEl('button', {
			text: '⏹ Stop',
			cls: 'lt-transcribe-btn lt-hidden',
		});
		this.stopBtn.addEventListener('click', () => {
			if (this._onStopClick) this._onStopClick();
		});

		// Setup initial level meter
		if (this.plugin.settings.liveMicDeviceId) {
			this.setupLevelMeter(this.plugin.settings.liveMicDeviceId);
		} else {
			navigator.mediaDevices.enumerateDevices().then(devices => {
				const audioInputs = devices.filter(d => d.kind === 'audioinput');
				if (audioInputs.length > 0) {
					const id = audioInputs[0]?.deviceId;
					if (id) {
						this.setupLevelMeter(id);
					}
				}
			});
		}

		// If session is already recording, update UI to reflect it
		if (this.plugin.transcriptionLive?.isRecording()) {
			this.setRecordingState('recording');
		} else if (this.plugin.transcriptionLive?.isPaused?.()) {
			this.setRecordingState('paused');
		}
	}

	async setupLevelMeter(deviceId: string) {
		this.cleanupMeter();
		try {
			this.mediaStream = await navigator.mediaDevices.getUserMedia({ audio: { deviceId } });
			this.audioContext = new AudioContext();
			const source = this.audioContext.createMediaStreamSource(this.mediaStream);
			this.analyser = this.audioContext.createAnalyser();
			this.analyser.fftSize = 256;
			source.connect(this.analyser);
			const dataArray = new Uint8Array(this.analyser.frequencyBinCount);

			const updateMeter = () => {
				if (!this.analyser) return;
				this.analyser.getByteFrequencyData(dataArray);
				let max = 0;
				for(let i = 0; i < dataArray.length; i++) {
					const val = dataArray[i];
					if(val !== undefined && val > max) max = val;
				}
				// Convert to roughly dB (-60 to 0)
				const db = max > 0 ? 20 * Math.log10(max / 255) : -60;
				if (this.levelMeter) {
					this.levelMeter.value = db;
				}
				this.meterInterval = window.requestAnimationFrame(updateMeter) as any;
			};
			updateMeter();
		} catch (e) {
			console.error("Failed to setup level meter", e);
		}
	}

	startTimer() {
		if (!this.timerInterval) {
			this.timerInterval = setInterval(() => {
				this.elapsedSeconds++;
				const mins = Math.floor(this.elapsedSeconds / 60).toString().padStart(2, '0');
				const secs = (this.elapsedSeconds % 60).toString().padStart(2, '0');
				if (this.timerLabel) {
					this.timerLabel.textContent = `${mins}:${secs}`;
				}
			}, 1000);
		}
	}

	stopTimer() {
		if (this.timerInterval) {
			clearInterval(this.timerInterval);
			this.timerInterval = null;
		}
	}

	resetTimer() {
		this.stopTimer();
		this.elapsedSeconds = 0;
		if (this.timerLabel) {
			this.timerLabel.textContent = '00:00';
		}
	}

	cleanupMeter() {
		if (this.meterInterval !== null) {
			window.cancelAnimationFrame(this.meterInterval);
			this.meterInterval = null;
		}
		if (this.audioContext) {
			this.audioContext.close();
			this.audioContext = null;
		}
		if (this.mediaStream) {
			this.mediaStream.getTracks().forEach(t => t.stop());
			this.mediaStream = null;
		}
	}

	onStartClick(callback: (micId: string) => void) {
		this._onStartClick = callback;
	}

	onPauseClick(callback: () => void) {
		this._onPauseClick = callback;
	}

	onStopClick(callback: () => void) {
		this._onStopClick = callback;
	}

	setRecordingState(status: 'idle' | 'recording' | 'paused') {
		if (status === 'recording') {
			this.startBtn.addClass('lt-hidden');
			this.pauseBtn.removeClass('lt-hidden');
			this.stopBtn.removeClass('lt-hidden');
			if (this._micDropdown) this._micDropdown.selectEl.disabled = true;
			this.startTimer();
		} else if (status === 'paused') {
			this.startBtn.removeClass('lt-hidden');
			this.startBtn.textContent = '▶ Resume';
			this.pauseBtn.addClass('lt-hidden');
			this.stopBtn.removeClass('lt-hidden');
			if (this._micDropdown) this._micDropdown.selectEl.disabled = true;
			this.stopTimer();
		} else {
			this.startBtn.removeClass('lt-hidden');
			this.startBtn.textContent = '▶ Start Dictation';
			this.pauseBtn.addClass('lt-hidden');
			this.stopBtn.addClass('lt-hidden');
			if (this._micDropdown) this._micDropdown.selectEl.disabled = false;
			this.resetTimer();
		}
	}

	log(text: string) {
		// Log removed from modal, use console for debug if needed
		console.log(`[Dictation] ${text}`);
	}

	setPreviewText(text: string) {
		if (this.previewArea) {
			this.previewArea.textContent = text || 'Waiting for speech...';
		}
	}

	onClose() {
		this.cleanupMeter();
		this.contentEl.empty();
	}
}
