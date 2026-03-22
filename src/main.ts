import { App, Editor, MarkdownView, Modal, Notice, Plugin, TFile } from 'obsidian';
import { DEFAULT_SETTINGS, LocalTranscriberSettings, LocalTranscriberSettingTab } from "./settings";
import { execFile, spawn } from 'child_process';
import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs';

export default class LocalTranscriberPlugin extends Plugin {
	settings: LocalTranscriberSettings;

	async onload() {
		await this.loadSettings();

		// Check environment on load if not ready
		if (!this.settings.envReady) {
			this.hasPython().then(hasPy => {
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
							.onClick(() => this.handleTranscribe(file))
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
						this.handleTranscribe(activeFile);
					}
					return true;
				}
				return false;
			}
		});

		this.addSettingTab(new LocalTranscriberSettingTab(this.app, this));
	}

	onunload() {
	}

	isMediaFile(file: TFile): boolean {
		const ext = file.extension.toLowerCase();
		return ['mp3', 'wav', 'm4a', 'ogg', 'mp4', 'mkv', 'avi', 'mov', 'webm'].includes(ext);
	}

	async handleTranscribe(file: TFile) {
		const modal = new TranscribeProgressModal(this.app);
		modal.open();

		try {
			modal.log('Checking environment...');
			await this.setupWhisperEnvironment(modal);

			modal.log('Preparing to process file...');

			// Resolve absolute path. Depending on Obsidian setup, this might be tricky,
			// but a common trick is to use adapter:
			const adapter = this.app.vault.adapter as unknown;
			let filePath = file.path;
			if (adapter.getBasePath) {
				filePath = path.join(adapter.getBasePath(), file.path);
			} else {
				throw new Error("Cannot determine absolute path of the file.");
			}

			modal.log(`Running Whisper (${this.settings.modelSize})...`);
			const result = await this.processFile(filePath, modal);

			modal.log('Generating subtitles...');
			await this.saveOutputs(file, result.segments);

			modal.log('Done!');
			new Notice('Transcription completed!');
		} catch (e: unknown) {
			modal.log(`Error: ${e.message}`);
			new Notice(`Transcription failed: ${e.message}`);
		} finally {
			// keep modal open to show result or error, user can close it.
		}
	}

	async setupWhisperEnvironment(modal: TranscribeProgressModal) {
		let hasPy = await this.hasPython();
		let hasFf = await this.hasFFmpeg();

		if (!hasPy && this.settings.installOnWindows && os.platform() === 'win32') {
			modal.log('Python not found. Installing Python (this may take several minutes)...');
			await this.installPythonWindows();
			hasPy = await this.hasPython();
		}

		if (!hasFf && this.settings.installOnWindows && os.platform() === 'win32') {
			modal.log('FFmpeg not found. Installing FFmpeg...');
			await this.installFFmpegWindows();
			hasFf = await this.hasFFmpeg();
		}

		if (!hasPy) {
			throw new Error("Python is required. Please install Python 3.10+ and add it to PATH.");
		}
		if (!hasFf) {
			throw new Error("FFmpeg is required. Please install FFmpeg and add it to PATH.");
		}

		this.settings.envReady = true;
		await this.saveSettings();

		if (!this.settings.modelsReady) {
			modal.log('Bootstrapping environment and downloading models (~500MB)...');
			await this.bootstrapPython(modal);
			this.settings.modelsReady = true;
			await this.saveSettings();
		}
	}

	getPythonExecutable(): string {
		return this.settings.pythonPath || (os.platform() === 'win32' ? 'python' : 'python3');
	}

	async hasPython(): Promise<boolean> {
		return new Promise((resolve) => {
			execFile(this.getPythonExecutable(), ['--version'], (error) => {
				if (error) {
					if (os.platform() !== 'win32' && !this.settings.pythonPath) {
						execFile('python3', ['--version'], (err2) => {
							resolve(!err2);
						});
					} else {
						resolve(false);
					}
				} else {
					resolve(true);
				}
			});
		});
	}

	async hasFFmpeg(): Promise<boolean> {
		return new Promise((resolve) => {
			execFile('ffmpeg', ['-version'], (error) => resolve(!error));
		});
	}

	async installPythonWindows(): Promise<void> {
		return new Promise((resolve, reject) => {
			execFile('winget', ['install', 'Python.Python.3.12', '--accept-package-agreements', '--accept-source-agreements'], (error, stdout, stderr) => {
				if (error) reject(new Error(`Failed to install Python: ${stderr || error.message}`));
				else resolve();
			});
		});
	}

	async installFFmpegWindows(): Promise<void> {
		return new Promise((resolve, reject) => {
			execFile('winget', ['install', 'FFmpeg (Essentials Build)', '--accept-package-agreements', '--accept-source-agreements'], (error, stdout, stderr) => {
				if (error) reject(new Error(`Failed to install FFmpeg: ${stderr || error.message}`));
				else resolve();
			});
		});
	}

	async bootstrapPython(modal: TranscribeProgressModal): Promise<void> {
		return new Promise((resolve, reject) => {
			const adapter = this.app.vault.adapter as unknown;
			const vaultPath = adapter.getBasePath ? adapter.getBasePath() : '';
			const pluginDir = path.join(vaultPath, this.app.vault.configDir, 'plugins', 'local-transcriber');
			const bootstrapScript = path.join(pluginDir, 'local_transcriber', 'bootstrap.py');
			const modelsDir = path.join(pluginDir, 'models');

			if (!fs.existsSync(modelsDir)) {
				fs.mkdirSync(modelsDir, { recursive: true });
			}

			const pyPath = this.getPythonExecutable();
			const child = spawn(pyPath, [bootstrapScript, '--models-dir', modelsDir]);

			child.stdout.on('data', (data) => {
				const lines = data.toString().split('\n').filter((l: string) => l.trim());
				for (const line of lines) {
					try {
						const msg = JSON.parse(line);
						if (msg.status === 'installing') modal.log(`Installing package: ${msg.package}...`);
						else if (msg.status === 'downloading_model') modal.log(`Downloading model: ${msg.model}...`);
					} catch (e) {
						// ignore
					}
				}
			});

			child.on('close', (code) => {
				if (code === 0) resolve();
				else reject(new Error(`Bootstrap failed with code ${code}`));
			});
		});
	}

	async processFile(inputPath: string, modal: TranscribeProgressModal): Promise<unknown> {
		return new Promise((resolve, reject) => {
			const adapter = this.app.vault.adapter as unknown;
			const vaultPath = adapter.getBasePath ? adapter.getBasePath() : '';
			const pluginDir = path.join(vaultPath, this.app.vault.configDir, 'plugins', 'local-transcriber');
			const transcribeScript = path.join(pluginDir, 'local_transcriber', 'transcribe.py');
			const modelsDir = path.join(pluginDir, 'models');

			const pyPath = this.getPythonExecutable();
			const child = spawn(pyPath, [
				transcribeScript,
				'--input', inputPath,
				'--model', this.settings.modelSize,
				'--language', this.settings.language,
				'--speakers', this.settings.speakers,
				'--models-dir', modelsDir
			]);

			let output = '';

			child.stdout.on('data', (data) => {
				output += data.toString();
			});

			let errOutput = '';
			child.stderr.on('data', (data) => {
				errOutput += data.toString();
			});

			child.on('close', (code) => {
				if (code !== 0) {
					reject(new Error(`Process failed with code ${code}. ${errOutput}`));
					return;
				}

				try {
					// Output might contain other prints, we find the last valid JSON object
					const lines = output.split('\n').filter(l => l.trim().startsWith('{'));
					if (lines.length > 0) {
						const lastLine = lines[lines.length - 1];
						if (lastLine) {
							const result = JSON.parse(lastLine);
							if (result.error) reject(new Error(result.error));
							else resolve(result);
						} else {
							reject(new Error("No valid JSON output from python backend"));
						}
					} else {
						reject(new Error("No valid JSON output from python backend"));
					}
				} catch (e) {
					reject(new Error(`Failed to parse python output: ${e}`));
				}
			});
		});
	}

	formatTime(seconds: number): string {
		const h = Math.floor(seconds / 3600);
		const m = Math.floor((seconds % 3600) / 60);
		const s = Math.floor(seconds % 60);
		const ms = Math.floor((seconds - Math.floor(seconds)) * 1000);

		const pad = (num: number, size: number) => ('000' + num).slice(size * -1);

		return `${pad(h, 2)}:${pad(m, 2)}:${pad(s, 2)},${pad(ms, 3)}`;
	}

	formatTimeTxt(seconds: number): string {
		const m = Math.floor(seconds / 60);
		const s = Math.floor(seconds % 60);
		const ms = Math.floor((seconds - Math.floor(seconds)) * 100);

		const pad = (num: number, size: number) => ('00' + num).slice(size * -1);

		return `[${pad(m, 2)}:${pad(s, 2)}.${pad(ms, 2)}]`;
	}

	async saveOutputs(file: TFile, segments: unknown[]) {
		const stem = file.basename;
		const folderPath = this.settings.audioFolder.endsWith('/') ? this.settings.audioFolder : this.settings.audioFolder + '/';

		// Create folder if not exists
		if (!await this.app.vault.adapter.exists(folderPath.replace(/\/$/, ''))) {
			await this.app.vault.createFolder(folderPath.replace(/\/$/, ''));
		}

		if (['SRT', 'Both'].includes(this.settings.outputFormat)) {
			let srtContent = '';
			segments.forEach((seg, i) => {
				srtContent += `${i + 1}\n`;
				srtContent += `${this.formatTime(seg.start)} --> ${this.formatTime(seg.end)}\n`;
				if (seg.speaker) {
					const speakerNum = seg.speaker.replace('SPEAKER_', '');
					srtContent += `Speaker ${parseInt(speakerNum) + 1}: ${seg.text}\n\n`;
				} else {
					srtContent += `${seg.text}\n\n`;
				}
			});

			const srtPath = `${folderPath}${stem}.srt`;
			const existing = this.app.vault.getAbstractFileByPath(srtPath);
			if (existing instanceof TFile) {
				await this.app.vault.modify(existing, srtContent.trim());
			} else {
				await this.app.vault.create(srtPath, srtContent.trim());
			}
		}

		if (['TXT', 'Both'].includes(this.settings.outputFormat)) {
			let txtContent = '';
			segments.forEach(seg => {
				const timeStr = this.formatTimeTxt(seg.start);
				if (seg.speaker) {
					const speakerNum = seg.speaker.replace('SPEAKER_', '');
					txtContent += `${timeStr} Speaker ${parseInt(speakerNum) + 1}: ${seg.text}\n`;
				} else {
					txtContent += `${timeStr} ${seg.text}\n`;
				}
			});

			const txtPath = `${folderPath}${stem}.txt`;
			const existing = this.app.vault.getAbstractFileByPath(txtPath);
			if (existing instanceof TFile) {
				await this.app.vault.modify(existing, txtContent.trim());
			} else {
				await this.app.vault.create(txtPath, txtContent.trim());
			}
		}
	}

	async loadSettings() {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData() as Partial<LocalTranscriberSettings>);
	}

	async saveSettings() {
		await this.saveData(this.settings);
	}
}

class TranscribeProgressModal extends Modal {
	logArea: HTMLDivElement;

	constructor(app: App) {
		super(app);
	}

	onOpen() {
		let { contentEl } = this;
		contentEl.empty();
		contentEl.createEl('h2', { text: 'Transcribing...' });

		this.logArea = contentEl.createDiv({ cls: 'transcribe-log-area' });
		this.logArea.style.maxHeight = '300px';
		this.logArea.style.overflowY = 'auto';
		this.logArea.style.fontFamily = 'monospace';
		this.logArea.style.whiteSpace = 'pre-wrap';
		this.logArea.style.background = 'var(--background-secondary)';
		this.logArea.style.padding = '10px';
		this.logArea.style.borderRadius = '5px';
	}

	log(message: string) {
		if (!this.logArea) return;
		const line = document.createElement('div');
		line.textContent = message;
		this.logArea.appendChild(line);
		this.logArea.scrollTop = this.logArea.scrollHeight;
	}

	onClose() {
		const { contentEl } = this;
		contentEl.empty();
	}
}
