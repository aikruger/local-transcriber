import { App, Notice, Plugin, TFile } from 'obsidian';
import { DEFAULT_SETTINGS, LocalTranscriberSettings, LocalTranscriberSettingTab } from "./settings";
import { PythonEnvironment } from './environment/python';
import { OllamaEnvironment } from './environment/ollama';
import { OutputWriters } from './output-writers';
import { TranscriptionFile } from './transcription-file';
import { TranscriptionLive } from './transcription-live';
import { LiveSessionManager } from './live-session';
import { Diagnostics } from './diagnostics';
import { ModelRegistry } from './models/registry';
import { ModelDiscovery } from './models/discovery';

export default class LocalTranscriberPlugin extends Plugin {
	settings: LocalTranscriberSettings;
	statusBarItem: HTMLElement;

	pythonEnv: PythonEnvironment;
	ollamaEnv: OllamaEnvironment;
	outputWriters: OutputWriters;
	transcriptionFile: TranscriptionFile;
	transcriptionLive: TranscriptionLive;
	liveSessionManager: LiveSessionManager;
	diagnostics: Diagnostics;

	modelRegistry: ModelRegistry;
	modelDiscovery: ModelDiscovery;

	async onload() {
		await this.loadSettings();

		this.statusBarItem = this.addStatusBarItem();
		this.statusBarItem.setText('');

		this.pythonEnv = new PythonEnvironment(this);
		this.ollamaEnv = new OllamaEnvironment();
		this.outputWriters = new OutputWriters(this);
		this.transcriptionFile = new TranscriptionFile(this);
		this.liveSessionManager = new LiveSessionManager(this);
		this.transcriptionLive = new TranscriptionLive(this);
		this.diagnostics = new Diagnostics(this);

		this.modelRegistry = new ModelRegistry();
		this.modelDiscovery = new ModelDiscovery(this.modelRegistry, this.ollamaEnv);

		this.modelDiscovery.refreshAll(this.settings.availableModels).catch(e => console.error("Failed to load models on startup", e));

		if (!this.settings.envReady) {
			this.pythonEnv.hasPython().then(hasPy => {
				if (hasPy) {
					this.settings.envReady = true;
					this.saveSettings();
				}
			});
		}

		this.registerEvent(
			this.app.workspace.on('file-menu', (menu, file) => {
				if (file instanceof TFile && this.isMediaFile(file)) {
					menu.addItem(item =>
						item
							.setTitle('🔊 Transcribe with Whisper')
							.onClick(() => this.transcriptionFile.handleTranscribe(file))
					);
				}
			})
		);

		this.addCommand({
			id: 'transcribe-current-file',
			name: 'Transcribe current file',
			checkCallback: (checking: boolean) => {
				const activeFile = this.app.workspace.getActiveFile();
				if (activeFile && this.isMediaFile(activeFile)) {
					if (!checking) {
						this.transcriptionFile.handleTranscribe(activeFile);
					}
					return true;
				}
				return false;
			}
		});

		this.addCommand({
			id: 'transcribe-external-file',
			name: 'Transcribe external file',
			callback: async () => {
				const input = document.createElement('input');
				input.type = 'file';
				input.accept = 'audio/*,video/*';
				input.style.display = 'none';
				document.body.appendChild(input);

				input.onchange = async (e: any) => {
					const files = e.target.files;
					if (files && files.length > 0) {
						const file = files[0];
						const filePath = file.path;
						const fileName = file.name;
						if (filePath) {
							await this.transcriptionFile.handleTranscribeExternal(filePath, fileName);
						} else {
							new Notice('Failed to get absolute path of file.');
						}
					}
					document.body.removeChild(input);
				};

				input.click();
			}
		});

		this.addCommand({
			id: 'start-live-transcription',
			name: 'Start live transcription',
			callback: async () => {
				await this.transcriptionLive.handleTranscribeLive();
			}
		});

		this.addCommand({
			id: 'stop-live-transcription',
			name: 'Stop live transcription',
			callback: async () => {
				if (this.transcriptionLive.isRecording()) {
					await this.transcriptionLive.stopLiveSession();
				} else {
					new Notice('No live transcription session running.');
				}
			}
		});

		this.addCommand({
			id: 'check-live-transcription-environment',
			name: 'Check live transcription environment',
			callback: async () => {
				await this.diagnostics.runDiagnostics();
			}
		});

		this.addSettingTab(new LocalTranscriberSettingTab(this.app, this));

		this.statusBarItem.onClickEvent(() => {
			if (this.transcriptionLive.isRecording()) {
				this.transcriptionLive.handleTranscribeLive();
			}
		});
	}

	onunload() {
	}

	isMediaFile(file: TFile): boolean {
		const ext = file.extension.toLowerCase();
		return ['mp3', 'wav', 'm4a', 'ogg', 'mp4', 'mkv', 'avi', 'mov', 'webm'].includes(ext);
	}

	async loadSettings() {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData() as Partial<LocalTranscriberSettings>);
	}

	async saveSettings() {
		await this.saveData(this.settings);
	}
}
