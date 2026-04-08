import { App, Modal, Notice, Setting, TFile } from 'obsidian';
import LocalTranscriberPlugin from '../main';
import { LiveTranscriptionSession, LiveSegment } from '../live-session';

export class LiveTranscribeModal extends Modal {
	private plugin: LocalTranscriberPlugin;
	private session: LiveTranscriptionSession | null = null;

	// UI Elements
	private startBtn: HTMLButtonElement;
	private stopBtn: HTMLButtonElement;
	private logArea: HTMLDivElement;
	private previewArea: HTMLDivElement;
	private runSection: HTMLDivElement;
	private micSelect: HTMLSelectElement;
	private levelMeter: HTMLMeterElement;
	private queueStatus: HTMLSpanElement;

	private _micDropdown: any;

	private mediaStream: MediaStream | null = null;
	private audioContext: AudioContext | null = null;
	private analyser: AnalyserNode | null = null;
	private meterInterval: number | null = null;

	private _onStartClick?: (micId: string) => void;
	private _onStopClick?: () => void;

	constructor(app: App, plugin: LocalTranscriberPlugin) {
		super(app);
		this.plugin = plugin;
	}

	async onOpen() {
		const { contentEl } = this;
		contentEl.empty();
		contentEl.addClass('local-transcriber-modal');
		contentEl.createEl('h2', { text: '🔴 Live Transcription' });

		const configSection = contentEl.createDiv({ cls: 'lt-config-section' });

		new Setting(configSection)
			.setName('Microphone')
			.setDesc('Select input device.')
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
		meterRow.createEl('span', { text: 'Mic Level: ', cls: 'lt-meter-label' });
		this.levelMeter = meterRow.createEl('meter', { cls: 'lt-level-meter' });
		this.levelMeter.min = -60;
		this.levelMeter.max = 0;
		this.levelMeter.value = -60;
		this.levelMeter.low = -20;
		this.levelMeter.high = -5;
		this.levelMeter.optimum = -10;

		const btnRow = contentEl.createDiv({ cls: 'lt-btn-row' });
		this.startBtn = btnRow.createEl('button', {
			text: '▶ Start Live Transcription',
			cls: 'mod-cta lt-transcribe-btn',
		});
		this.startBtn.addEventListener('click', () => {
			if (this._onStartClick) {
				const micId = this._micDropdown.getValue();
				this._onStartClick(micId);
			}
		});

		this.stopBtn = btnRow.createEl('button', {
			text: '⏹ Stop',
			cls: 'lt-transcribe-btn lt-hidden',
		});
		this.stopBtn.addEventListener('click', () => {
			if (this._onStopClick) this._onStopClick();
		});

		this.runSection = contentEl.createDiv({ cls: 'lt-run-section lt-hidden' });

		const statusRow = this.runSection.createDiv({ cls: 'lt-progress-row' });
		this.queueStatus = statusRow.createEl('span', {
			cls: 'lt-progress-label',
			text: 'Chunks queued: 0',
		});

		this.runSection.createEl('h4', { text: 'Live Transcript Preview' });
		this.previewArea = this.runSection.createDiv({ cls: 'lt-preview-area', attr: {style: 'height: 150px;'} });

		this.runSection.createEl('h4', { text: 'Log' });
		this.logArea = this.runSection.createDiv({ cls: 'lt-log-area', attr: {style: 'height: 100px;'} });

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
	}

	setStage(stage: string) {
		this.log(stage);
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

	onStopClick(callback: () => void) {
		this._onStopClick = callback;
	}

	setRecordingState(isRecording: boolean) {
		if (isRecording) {
			this.startBtn.addClass('lt-hidden');
			this.stopBtn.removeClass('lt-hidden');
			this.runSection.removeClass('lt-hidden');
			if (this._micDropdown) this._micDropdown.selectEl.disabled = true;
		} else {
			this.startBtn.removeClass('lt-hidden');
			this.stopBtn.addClass('lt-hidden');
			if (this._micDropdown) this._micDropdown.selectEl.disabled = false;
		}
	}

	updateQueueStatus(count: number) {
		if (this.queueStatus) {
			this.queueStatus.textContent = `Chunks queued: ${count}`;
		}
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

	onClose() {
		this.cleanupMeter();
		this.contentEl.empty();
	}
}
