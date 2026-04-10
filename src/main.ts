import { App, Editor, MarkdownView, Modal, Notice, Plugin, TFile, Setting } from 'obsidian';
import { DEFAULT_SETTINGS, LocalTranscriberSettings, LocalTranscriberSettingTab } from "./settings";
import * as path from 'path';
import { Environment } from './environment';
import { OutputWriters } from './output-writers';
import { TranscriptionFile } from './transcription-file';
import { TranscriptionLive } from './transcription-live';
import { LiveSessionManager } from './live-session';

export default class LocalTranscriberPlugin extends Plugin {
	settings: LocalTranscriberSettings;
	statusBarItem: HTMLElement;

	environment: Environment;
	outputWriters: OutputWriters;
	transcriptionFile: TranscriptionFile;
	transcriptionLive: TranscriptionLive;
	liveSessionManager: LiveSessionManager;

	async onload() {
		await this.loadSettings();

		this.statusBarItem = this.addStatusBarItem();
		this.statusBarItem.setText('');

		this.environment = new Environment(this);
		this.outputWriters = new OutputWriters(this);
		this.transcriptionFile = new TranscriptionFile(this);
		this.liveSessionManager = new LiveSessionManager(this);
		this.transcriptionLive = new TranscriptionLive(this);

		// Check environment on load if not ready
		if (!this.settings.envReady) {
			this.environment.hasPython().then(hasPy => {
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
						// Obsidian/Electron specific: File object has `.path`
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

			if (!fs.existsSync(modelsDir)) {
				fs.mkdirSync(modelsDir, { recursive: true });
			}

			const pyPath = this.getPythonExecutable();
			const child = spawn(pyPath, [bootstrapScript, '--models-dir', modelsDir]);

			let stderrOutput = '';
			child.stderr.on('data', (data) => {
				stderrOutput += data.toString();
				const lines = data.toString().split('\n').filter((l: string) => l.trim());
				for (const line of lines) {
					modal.log(`[stderr] ${line}`);
				}
			});

			child.stdout.on('data', (data) => {
				const lines = data.toString().split('\n').filter((l: string) => l.trim());
				for (const line of lines) {
					try {
						const msg = JSON.parse(line);
						if (msg.status === 'installing') modal.log(`Installing: ${msg.package}...`);
						else if (msg.status === 'downloading_model') modal.log(`Downloading model: ${msg.model}...`);
						else if (msg.status === 'done') modal.log('Bootstrap complete.');
					} catch (e) {
						modal.log(line);
					}
				}
			});

			child.on('close', (code) => {
				if (code === 0) resolve();
				else {
					reject(new Error(
						`Bootstrap failed with code ${code}.\n` +
						(stderrOutput ? `Python error:\n${stderrOutput}` : 'No stderr output captured.')
					));
				}
			});
		});
	}

		this.statusBarItem.onClickEvent(() => {
			if (this.transcriptionLive.isRecording()) {
				this.transcriptionLive.handleTranscribeLive();
			}
		});
	}

		this.addCommand({
			id: 'check-live-transcription-environment',
			name: 'Check live transcription environment',
			callback: async () => {
				await this.runDiagnostics();
			}
		});

		this.addSettingTab(new LocalTranscriberSettingTab(this.app, this));
	}

	async runDiagnostics() {
		new Notice('Running diagnostics...');
		try {
			const pyPath = this.environment.getPythonExecutable();

			// Check python imports
			const checkScript = `
import sys
try:
	import whisper
	import pyannote.audio
	import soundfile
	import numpy
	print('OK')
except Exception as e:
	print(f'Error: {e}')
	sys.exit(1)
			`;

			const { exec } = require('child_process');
			const fs = require('fs');
			const util = require('util');
			const execPromise = util.promisify(exec);

			const result = await execPromise(`"${pyPath}" -c "${checkScript.replace(/\n/g, '; ')}"`);
			if (result.stdout.trim() === 'OK') {
				new Notice('✅ Python imports OK (whisper, pyannote, soundfile, numpy)');
			}

			const hasMic = await navigator.mediaDevices.getUserMedia({ audio: true }).then(() => true).catch(() => false);
			if (hasMic) {
				new Notice('✅ Microphone access OK');
			} else {
				new Notice('❌ Microphone access denied or unavailable');
			}

			const folderPath = this.settings.liveOutputFolder;
			const adapter = this.app.vault.adapter as any;
			if (!await adapter.exists(folderPath.replace(/\/$/, ''))) {
				await this.app.vault.createFolder(folderPath.replace(/\/$/, ''));
			}
			new Notice('✅ Write permissions to output folder OK');

			const hasFf = await this.environment.hasFFmpeg();
			if (hasFf) {
				new Notice('✅ FFmpeg OK');
			} else {
				new Notice('❌ FFmpeg not found');
			}

		} catch (e: any) {
			new Notice(`❌ Diagnostics failed: ${e.message}`);
		}
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
