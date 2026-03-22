import { App, Editor, MarkdownView, Modal, Notice, Plugin, TFile, Setting } from 'obsidian';
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

		this.addCommand({
			id: 'transcribe-external-file',
			name: 'Transcribe external file',
			callback: async () => {
				// Require electron dynamically so the plugin can still load without it
				// (even if the command won't work on mobile, standard Obsidian isDesktopOnly handles it)
				const { remote } = require('electron');
				const { dialog } = remote;
				const result = await dialog.showOpenDialog({
					title: 'Select audio or video file',
					properties: ['openFile'],
					filters: [
						{
							name: 'Audio/Video',
							extensions: ['mp3', 'wav', 'm4a', 'ogg', 'mp4', 'mkv', 'avi', 'mov', 'webm'],
						},
					],
				});

				if (!result.canceled && result.filePaths.length > 0) {
					const filePath = result.filePaths[0];
					const fileName = path.basename(filePath);
					await this.handleTranscribeExternal(filePath, fileName);
				}
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

	getAbsolutePath(file: TFile): string {
		const adapter = this.app.vault.adapter as any;
		if (adapter && typeof adapter.getBasePath === 'function') {
			return path.join(adapter.getBasePath(), file.path);
		}
		throw new Error(
			'Cannot resolve absolute path. Ensure you are running Obsidian on desktop.'
		);
	}

	async handleTranscribe(file: TFile) {
		const modal = new TranscribeModal(this.app, this);
		modal.open();

		try {
			modal.setStage('Checking environment');
			await this.setupWhisperEnvironment(modal);

			modal.setStage('Preparing audio');
			const filePath = this.getAbsolutePath(file);

			modal.setStage('Transcribing');
			const result: any = await this.processFile(filePath, modal, modal.selectedModel, modal.selectedSpeakers);

			modal.setStage('Saving outputs');
			await this.saveOutputs(file.basename, result.segments);

			modal.setStage('Done');
			new Notice('Transcription completed!');
		} catch (err: any) {
			const msg = err?.message ?? 'Unknown error';
			modal.log(`❌ Error: ${msg}`);
			new Notice(`Transcription failed — see modal for details.`);
		} finally {
			// keep modal open to show result or error, user can close it.
		}
	}

	async handleTranscribeExternal(filePath: string, fileName: string) {
		if (!filePath || filePath.trim() === '') {
			new Notice('No file path provided.');
			return;
		}

		const modal = new TranscribeModal(this.app, this);
		modal.open();

		try {
			modal.setStage('Checking environment');
			await this.setupWhisperEnvironment(modal);

			modal.setStage('Preparing audio');
			const lastDotIndex = fileName.lastIndexOf('.');
			const stem = lastDotIndex !== -1 ? fileName.substring(0, lastDotIndex) : fileName;

			modal.setStage('Transcribing');
			const result: any = await this.processFile(filePath, modal, modal.selectedModel, modal.selectedSpeakers);

			modal.setStage('Saving outputs');
			await this.saveOutputs(stem, result.segments);

			modal.setStage('Done');
			new Notice('Transcription completed!');
		} catch (err: any) {
			const msg = err?.message ?? 'Unknown error';
			modal.log(`❌ Error: ${msg}`);
			new Notice(`Transcription failed — see modal for details.`);
		}
	}

	async setupWhisperEnvironment(modal: TranscribeModal) {
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
			modal.setStage('Bootstrapping models');
			modal.log('Downloading models (~500MB)...');
			await this.bootstrapPython(modal);
			this.settings.modelsReady = true;
			await this.saveSettings();
		}
	}

	getModelsDir(): string {
		if (this.settings.modelsFolder && this.settings.modelsFolder.trim() !== '') {
			return this.settings.modelsFolder.trim();
		}
		const adapter: any = this.app.vault.adapter;
		const base = adapter?.getBasePath ? adapter.getBasePath() : '';
		return path.join(base, this.app.vault.configDir, 'plugins', 'local-transcriber', 'models');
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

	async bootstrapPython(modal: TranscribeModal): Promise<void> {
		return new Promise((resolve, reject) => {
			const adapter: any = this.app.vault.adapter;
			const vaultPath = adapter && adapter.getBasePath ? adapter.getBasePath() : '';
			const pluginDir = path.join(vaultPath, this.app.vault.configDir, 'plugins', 'local-transcriber');
			const bootstrapScript = path.join(pluginDir, 'local_transcriber', 'bootstrap.py');
			const modelsDir = this.getModelsDir();

			if (!fs.existsSync(bootstrapScript)) {
				reject(new Error(
					`bootstrap.py not found at: ${bootstrapScript}\n` +
					`Ensure the local_transcriber/ folder is inside the plugin directory.`
				));
				return;
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

	async processFile(
		inputPath: string,
		modal: TranscribeModal,
		modelOverride?: string,
		speakersOverride?: string
	): Promise<unknown> {
		const modelToUse = modelOverride ?? this.settings.modelSize;
		const speakersToUse = speakersOverride ?? this.settings.speakers;

		return new Promise((resolve, reject) => {
			const adapter: any = this.app.vault.adapter;
			const vaultPath = adapter && adapter.getBasePath ? adapter.getBasePath() : '';
			const pluginDir = path.join(vaultPath, this.app.vault.configDir, 'plugins', 'local-transcriber');
			const transcribeScript = path.join(pluginDir, 'local_transcriber', 'transcribe.py');
			const modelsDir = this.getModelsDir();

			const pyPath = this.getPythonExecutable();
			const child = spawn(pyPath, [
				transcribeScript,
				'--input', inputPath,
				'--model', modelToUse,
				'--language', this.settings.language,
				'--speakers', speakersToUse,
				'--models-dir', modelsDir
			]);

			let finalJson = '';
			let totalDuration = 0;
			let rawStdout = '';

			child.stdout.on('data', (chunk) => {
				const text = chunk.toString();
				rawStdout += text;
				const lines = text.split('\n').filter((l: string) => l.trim());
				for (const line of lines) {
					if (line.startsWith('{')) {
						try {
							const msg = JSON.parse(line);
							if (msg.type === 'segment') {
								const speaker = msg.speaker
									? `Speaker ${parseInt(msg.speaker.replace('SPEAKER_', '')) + 1}: `
									: '';
								const timestamp = this.formatTimeTxt(msg.start);
								modal.appendPreview(`${timestamp} ${speaker}${msg.text}`);
								if (totalDuration > 0) {
									// Progress between 40% and 83% during transcription
									const pct = 40 + ((msg.end / totalDuration) * 43);
									modal.setProgress(pct);
								}
							} else if (msg.type === 'meta') {
								totalDuration = msg.duration || 0;
							} else if (msg.type === 'result') {
								finalJson = line;
							}
						} catch {
							// not JSON, ignore
						}
					}
				}
			});

			let stderrOutput = '';
			child.stderr.on('data', (data) => {
				stderrOutput += data.toString();
			});

			child.on('close', (code) => {
				if (code !== 0) {
					reject(new Error(`Process failed with code ${code}.\n${stderrOutput || 'No stderr.'}`));
					return;
				}

				// Try typed result line first
				if (finalJson) {
					try {
						const parsed = JSON.parse(finalJson);
						if (parsed.error) {
							reject(new Error(parsed.error));
							return;
						}
						resolve(parsed);
						return;
					} catch {
						/* fall through */
					}
				}

				// Fallback: scan all stdout lines for any JSON with a "segments" array
				const allLines = rawStdout.split('\n').filter(l => l.trim().startsWith('{'));
				for (let i = allLines.length - 1; i >= 0; i--) {
					try {
						const candidate = JSON.parse(allLines[i]!);
						if (Array.isArray(candidate.segments)) {
							resolve(candidate);
							return;
						}
					} catch {
						/* keep scanning */
					}
				}

				// Nothing usable — show what Python actually said
				reject(new Error(
					`No valid JSON result from Python backend.\n` +
					`stdout was:\n${rawStdout.slice(0, 500)}\n` +
					`stderr was:\n${stderrOutput.slice(0, 500)}`
				));
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

	async saveOutputs(stem: string, segments: any[]) {
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

		const createMD = this.settings.outputFormat === 'MD' || this.settings.createMarkdownNote;
		const mdOnlyMode = this.settings.outputFormat === 'MD';

		if (createMD) {
			let md = `# Transcription: ${stem}\n\n`;

			if (!mdOnlyMode) {
				// Embed the SRT/TXT file as before
				const embedFile = ['SRT', 'Both'].includes(this.settings.outputFormat)
					? `${folderPath}${stem}.srt`
					: `${folderPath}${stem}.txt`;
				md += `![[${embedFile}]]\n\n---\n\n`;
			}

			// Build inline transcript (see Feature 4 for paragraph grouping)
			md += this.buildMarkdownTranscript(segments);

			const mdPath = `${folderPath}${stem}.md`;
			const existingMd = this.app.vault.getAbstractFileByPath(mdPath);
			if (existingMd instanceof TFile) {
				await this.app.vault.modify(existingMd, md.trim());
			} else {
				await this.app.vault.create(mdPath, md.trim());
			}
		}
	}

	buildMarkdownTranscript(segments: any[]): string {
		if (!segments || segments.length === 0) return '_No speech detected._\n';

		const intervalSec = this.settings.markdownInterval * 60;   // 0 = no grouping
		const pauseGap = this.settings.markdownPauseGap;

		let output = '';
		let paragraphLines: string[] = [];
		let currentBlockStart = segments[0].start;

		const flushParagraph = (blockTimestamp: number) => {
			if (paragraphLines.length === 0) return;
			const label = this.formatTimeTxt(blockTimestamp);
			output += `**${label}**\n\n`;
			output += paragraphLines.join(' ') + '\n\n';
			paragraphLines = [];
		};

		for (let i = 0; i < segments.length; i++) {
			const seg = segments[i];
			const prev = i > 0 ? segments[i - 1] : null;

			// Detect interval boundary
			const intervalBoundary = intervalSec > 0 && (seg.start - currentBlockStart) >= intervalSec;

			// Detect natural pause boundary
			const naturalPause = prev !== null && (seg.start - prev.end) >= pauseGap;

			if (intervalBoundary || (naturalPause && intervalSec > 0)) {
				flushParagraph(currentBlockStart);
				currentBlockStart = seg.start;
			} else if (naturalPause && intervalSec === 0) {
				// No interval grouping — just insert blank line at natural pauses
				if (paragraphLines.length > 0) {
					output += paragraphLines.join(' ') + '\n\n';
					paragraphLines = [];
				}
				currentBlockStart = seg.start;
			}

			// Build the segment line
			const speakerPrefix = seg.speaker
				? `**Speaker ${parseInt(seg.speaker.replace('SPEAKER_', '')) + 1}:** `
				: '';

			if (intervalSec === 0) {
				// No grouping: one line per segment with inline timestamp
				const ts = this.formatTimeTxt(seg.start);
				output += `${ts} ${speakerPrefix}${seg.text}\n\n`;
			} else {
				// Grouping mode: accumulate lines, emit timestamp as paragraph header
				paragraphLines.push(`${speakerPrefix}${seg.text.trim()}`);
			}
		}

		// Flush remaining
		if (intervalSec > 0) flushParagraph(currentBlockStart);

		return output;
	}

	async loadSettings() {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData() as Partial<LocalTranscriberSettings>);
	}

	async saveSettings() {
		await this.saveData(this.settings);
	}
}

class TranscribeModal extends Modal {
	private plugin: LocalTranscriberPlugin;
	selectedModel: string;
	selectedSpeakers: string;

	private logArea: HTMLDivElement;
	private progressBar: HTMLProgressElement;
	private progressLabel: HTMLSpanElement;
	private previewArea: HTMLDivElement;

	// Ordered stages with % completion values
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
	}

	onOpen() {
		const { contentEl } = this;
		contentEl.empty();
		contentEl.addClass('local-transcriber-modal');
		contentEl.createEl('h2', { text: '🔊 Transcriber' });

		// Model selector
		const models = this.plugin.settings.availableModels
			.split('\n')
			.map(m => m.trim())
			.filter(m => m.length > 0);

		if (models.length > 0) {
			const modelRow = new Setting(contentEl)
				.setName('Model')
				.setDesc('Select Whisper model for this transcription');
			modelRow.addDropdown((dd: any) => {
				models.forEach(m => dd.addOption(m, m));
				dd.setValue(this.selectedModel);
				dd.onChange((val: string) => { this.selectedModel = val; });
			});
		}

		// Speaker count selector
		new Setting(contentEl)
			.setName('Speakers')
			.setDesc('Number of speakers to identify. 0 = disable diarization.')
			.addDropdown((dd: any) => {
				dd.addOption('0', 'None (no diarization)');
				dd.addOption('auto', 'Auto-detect');
				dd.addOption('2', '2 speakers');
				dd.addOption('3', '3 speakers');
				dd.addOption('4', '4 speakers');
				dd.addOption('6', '6 speakers');
				dd.setValue(this.selectedSpeakers);
				dd.onChange((val: string) => { this.selectedSpeakers = val; });
			});

		// Progress bar row
		const progressRow = contentEl.createDiv({ cls: 'lt-progress-row' });
		this.progressLabel = progressRow.createEl('span', {
			cls: 'lt-progress-label',
			text: 'Starting...',
		});
		this.progressBar = progressRow.createEl('progress');
		this.progressBar.max = 100;
		this.progressBar.value = 0;
		this.progressBar.addClass('lt-progress-bar');

		// Log area
		contentEl.createEl('h4', { text: 'Log' });
		this.logArea = contentEl.createDiv({ cls: 'lt-log-area' });

		// Live preview area
		contentEl.createEl('h4', { text: 'Live Transcript Preview' });
		this.previewArea = contentEl.createDiv({ cls: 'lt-preview-area' });
	}

	setStage(stageName: string) {
		const stage = this.stages.find(s => s.name === stageName);
		if (!stage) return;
		this.progressBar.value = stage.pct;
		this.progressLabel.textContent = stage.name + '...';
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

	onClose() {
		this.contentEl.empty();
	}
}
