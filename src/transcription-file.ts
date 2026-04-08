import { App, Notice, TFile } from 'obsidian';
import * as path from 'path';
import { spawn } from 'child_process';
import LocalTranscriberPlugin from './main';
import { TranscribeModal } from './ui/transcribe-modal';

export class TranscriptionFile {
	plugin: LocalTranscriberPlugin;
	app: App;

	constructor(plugin: LocalTranscriberPlugin) {
		this.plugin = plugin;
		this.app = plugin.app;
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
		const modal = new TranscribeModal(this.app, this.plugin);
		modal.open();

		modal.onTranscribeClick(async () => {
			modal.startRunning();
			this.plugin.statusBarItem.setText('🔊 Transcribing...');
			try {
				modal.setStage('Checking environment');
				await this.plugin.environment.setupWhisperEnvironment(modal);

				modal.setStage('Preparing audio');
				const filePath = this.getAbsolutePath(file);

				modal.setStage('Transcribing');
				const result: any = await this.processFile(filePath, modal, modal.selectedModel, modal.selectedSpeakers);

				modal.setStage('Saving outputs');
				await this.plugin.outputWriters.saveOutputs(file.basename, result.segments, modal.selectedInterval, modal.selectedPauseGap);

				modal.setStage('Done');
				modal._isRunning = false;
				modal.transcribeBtn.textContent = '✅ Done — Transcribe again?';
				modal.transcribeBtn.disabled = false;
				new Notice('Transcription completed!');
			} catch (err: any) {
				const msg = err?.message ?? 'Unknown error';
				modal.log(`❌ Error: ${msg}`);
				modal._isRunning = false;
				modal.transcribeBtn.textContent = '❌ Failed — Retry?';
				modal.transcribeBtn.disabled = false;
				new Notice(`Transcription failed — see modal for details.`);
			} finally {
				this.plugin.statusBarItem.setText('');
			}
		});
	}

	async handleTranscribeExternal(filePath: string, fileName: string) {
		if (!filePath || filePath.trim() === '') {
			new Notice('No file path provided.');
			return;
		}

		const modal = new TranscribeModal(this.app, this.plugin);
		modal.open();

		modal.onTranscribeClick(async () => {
			modal.startRunning();
			this.plugin.statusBarItem.setText('🔊 Transcribing...');
			try {
				modal.setStage('Checking environment');
				await this.plugin.environment.setupWhisperEnvironment(modal);

				modal.setStage('Preparing audio');
				const lastDotIndex = fileName.lastIndexOf('.');
				const stem = lastDotIndex !== -1 ? fileName.substring(0, lastDotIndex) : fileName;

				modal.setStage('Transcribing');
				const result: any = await this.processFile(filePath, modal, modal.selectedModel, modal.selectedSpeakers);

				modal.setStage('Saving outputs');
				await this.plugin.outputWriters.saveOutputs(stem, result.segments, modal.selectedInterval, modal.selectedPauseGap);

				modal.setStage('Done');
				modal._isRunning = false;
				modal.transcribeBtn.textContent = '✅ Done — Transcribe again?';
				modal.transcribeBtn.disabled = false;
				new Notice('Transcription completed!');
			} catch (err: any) {
				const msg = err?.message ?? 'Unknown error';
				modal.log(`❌ Error: ${msg}`);
				modal._isRunning = false;
				modal.transcribeBtn.textContent = '❌ Failed — Retry?';
				modal.transcribeBtn.disabled = false;
				new Notice(`Transcription failed — see modal for details.`);
			} finally {
				this.plugin.statusBarItem.setText('');
			}
		});
	}

	async processFile(
		inputPath: string,
		modal: TranscribeModal,
		modelOverride?: string,
		speakersOverride?: string
	): Promise<unknown> {
		const modelToUse = modelOverride ?? this.plugin.settings.modelSize;
		const speakersToUse = speakersOverride ?? this.plugin.settings.speakers;

		return new Promise((resolve, reject) => {
			const adapter: any = this.app.vault.adapter;
			const vaultPath = adapter && adapter.getBasePath ? adapter.getBasePath() : '';
			const pluginDir = path.join(vaultPath, this.app.vault.configDir, 'plugins', 'local-transcriber');
			const transcribeScript = path.join(pluginDir, 'local_transcriber', 'transcribe.py');
			const modelsDir = this.plugin.environment.getModelsDir();

			const pyPath = this.plugin.environment.getPythonExecutable();
			const child = spawn(pyPath, [
				transcribeScript,
				'--input', inputPath,
				'--model', modelToUse,
				'--language', this.plugin.settings.language,
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
								const timestamp = this.plugin.outputWriters.formatTimeTxt(msg.start);
								modal.appendPreview(`${timestamp} ${speaker}${msg.text}`);
								if (totalDuration > 0) {
									const pct = 40 + ((msg.end / totalDuration) * 43);
									modal.setProgress(pct);
								}
							} else if (msg.type === 'meta') {
								totalDuration = msg.duration || 0;
							} else if (msg.type === 'result') {
								finalJson = line;
							}
						} catch {
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
					}
				}

				const allLines = rawStdout.split('\n').filter(l => l.trim().startsWith('{'));
				for (let i = allLines.length - 1; i >= 0; i--) {
					try {
						const candidate = JSON.parse(allLines[i]!);
						if (Array.isArray(candidate.segments)) {
							resolve(candidate);
							return;
						}
					} catch {
					}
				}

				reject(new Error(
					`No valid JSON result from Python backend.\n` +
					`stdout was:\n${rawStdout.slice(0, 500)}\n` +
					`stderr was:\n${stderrOutput.slice(0, 500)}`
				));
			});
		});
	}
}
