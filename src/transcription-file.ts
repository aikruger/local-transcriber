import { App, Notice, TFile } from 'obsidian';
import * as path from 'path';
import LocalTranscriberPlugin from './main';
import { TranscribeModal } from './ui/transcribe-modal';
import { PythonWhisperFileBackend } from './transcription/file/python-whisper';
import { OllamaFileBackend } from './transcription/file/ollama';

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

				const modelDesc = this.plugin.modelRegistry.getModel(
					(modal.selectedModel ?? this.plugin.settings.modelSize).split('::')[0] as any,
					(modal.selectedModel ?? this.plugin.settings.modelSize).split('::').slice(1).join('::')
				);

				if (!modelDesc) throw new Error("Selected model not found.");

				if (modelDesc.backend === 'python-whisper') {
					await this.plugin.pythonEnv.setupWhisperEnvironment(modal);
				} else if (modelDesc.backend === 'ollama') {
					if (!await this.plugin.ollamaEnv.isOllamaRunning()) {
						throw new Error("Ollama is not running. Please start Ollama.");
					}
				}

				modal.setStage('Preparing audio');
				const filePath = this.getAbsolutePath(file);

				modal.setStage('Transcribing');
				const result: any = await this.processFile(filePath, modal, modal.selectedModel ?? this.plugin.settings.modelSize, modal.selectedSpeakers ?? this.plugin.settings.speakers);


					if (modal.selectedSpeakers !== '0' && result.segments && !result.segments.some((s: any) => !!s.speaker)) {
						new Notice('Diarization did not produce speaker labels; check Python/Pyannote setup.');
					}
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

		const fs = require('fs');
		if (!fs.existsSync(filePath)) {
			new Notice(`File not found: ${filePath}`);
			return;
		}

		const ext = filePath.split('.').pop()?.toLowerCase();
		const allowedExts = ['mp3', 'wav', 'm4a', 'ogg', 'mp4', 'mkv', 'avi', 'mov', 'webm'];
		if (!ext || !allowedExts.includes(ext)) {
			new Notice(`Unsupported file extension: ${ext}`);
			return;
		}

		const modal = new TranscribeModal(this.app, this.plugin);
		modal.open();

		modal.onTranscribeClick(async () => {
			modal.startRunning();
			this.plugin.statusBarItem.setText('🔊 Transcribing...');
			try {
				modal.setStage('Checking environment');

				const modelDesc = this.plugin.modelRegistry.getModel(
					(modal.selectedModel ?? this.plugin.settings.modelSize).split('::')[0] as any,
					(modal.selectedModel ?? this.plugin.settings.modelSize).split('::').slice(1).join('::')
				);

				if (!modelDesc) throw new Error("Selected model not found.");

				if (modelDesc.backend === 'python-whisper') {
					await this.plugin.pythonEnv.setupWhisperEnvironment(modal);
				} else if (modelDesc.backend === 'ollama') {
					if (!await this.plugin.ollamaEnv.isOllamaRunning()) {
						throw new Error("Ollama is not running. Please start Ollama.");
					}
				}

				modal.setStage('Preparing audio');
				const lastDotIndex = fileName.lastIndexOf('.');
				const stem = lastDotIndex !== -1 ? fileName.substring(0, lastDotIndex) : fileName;

				modal.setStage('Transcribing');
				const result: any = await this.processFile(filePath, modal, modal.selectedModel ?? this.plugin.settings.modelSize, modal.selectedSpeakers ?? this.plugin.settings.speakers);


					if (modal.selectedSpeakers !== '0' && result.segments && !result.segments.some((s: any) => !!s.speaker)) {
						new Notice('Diarization did not produce speaker labels; check Python/Pyannote setup.');
					}
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
		const fullModelId = modelOverride ?? this.plugin.settings.modelSize;
		const speakersToUse = speakersOverride ?? this.plugin.settings.speakers;

		const backendStr = fullModelId.split('::')[0];
		const modelId = fullModelId.split('::').slice(1).join('::');

		const modelsDir = this.plugin.pythonEnv.getModelsDir();

		let totalDuration = 0;

		const options = {
			inputPath,
			modelId,
			language: this.plugin.settings.fileLanguage,
			speakers: speakersToUse,
			modelsDir
		};

		const onEvent = (msg: any) => {
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
			}
		};

		if (backendStr === 'python-whisper') {
			const backend = new PythonWhisperFileBackend(this.plugin);
			return backend.transcribeFile(options, onEvent);
		} else if (backendStr === 'ollama') {
			const backend = new OllamaFileBackend(this.plugin);
			return backend.transcribeFile(options, onEvent);
		}

		throw new Error("Unknown backend");
	}
}
