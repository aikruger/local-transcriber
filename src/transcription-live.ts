import { App, Notice } from 'obsidian';
import LocalTranscriberPlugin from './main';
import { LiveTranscribeModal } from './ui/live-modal';
import { LiveTranscriptionSession, LiveSegment } from './live-session';
import { PythonWhisperLiveBackend } from './transcription/live/python-whisper';
import { OllamaLiveBackend } from './transcription/live/ollama';
import * as path from 'path';
import * as fs from 'fs';

export class TranscriptionLive {
	plugin: LocalTranscriberPlugin;
	app: App;

	private session: LiveTranscriptionSession | null = null;
	private isProcessingChunk: boolean = false;
	private chunkQueue: string[] = [];

	private modal: LiveTranscribeModal | null = null;

	// Audio capture state
	private audioContext: AudioContext | null = null;
	private mediaStream: MediaStream | null = null;
	private processor: ScriptProcessorNode | null = null;
	private sourceNode: MediaStreamAudioSourceNode | null = null;
	private recordedSamples: Float32Array[] = [];
	private recordingOffset: number = 0;
	private sampleRate: number = 16000;

	private failedChunks: string[] = [];

	constructor(plugin: LocalTranscriberPlugin) {
		this.plugin = plugin;
		this.app = plugin.app;
	}

	isRecording(): boolean {
		return this.session !== null && this.session.status === 'recording';
	}

	isPaused(): boolean {
		return this.session !== null && this.session.status === 'paused';
	}

	async handleTranscribeLive() {
		if (!this.modal || !document.contains(this.modal.modalEl)) {
			this.modal = new LiveTranscribeModal(this.app, this.plugin);
			this.modal.open();
		}

		this.modal.onStartClick(async (micId: string) => {
			try {
				if (this.isPaused()) {
					await this.resumeLiveSession();
				} else {
					const fullModelId = this.plugin.settings.liveModelSize;
					const backendStr = fullModelId.split('::')[0];
					if (backendStr === 'python-whisper') {
						await this.plugin.pythonEnv.setupWhisperEnvironment({
							log: (msg) => console.log(`[Dictation] ${msg}`),
							setStage: (stage) => console.log(`[Dictation Stage] ${stage}`)
						});
					} else if (backendStr === 'ollama') {
						if (!await this.plugin.ollamaEnv.isOllamaRunning()) {
							throw new Error("Ollama is not running.");
						}
					}
					await this.startLiveSession(micId);
				}
			} catch (err: any) {
				const msg = err?.message ?? 'Unknown error';
				this.modal?.log(`❌ Error: ${msg}`);
				new Notice(`Live Transcription failed — see modal for details.`);
			}
		});

		this.modal.onPauseClick(() => {
			this.pauseLiveSession();
		});

		this.modal.onStopClick(async () => {
			await this.stopLiveSession();
		});
	}

	isSamplesSilent(samples: Float32Array, gateDb: number): boolean {
		if (gateDb <= -60) return false;
		let sumSquares = 0;
		for (let i = 0; i < samples.length; i++) {
			const s = samples[i];
			if (s !== undefined) {
				sumSquares += s * s;
			}
		}
		const rms = Math.sqrt(sumSquares / samples.length);
		const db = rms > 0 ? 20 * Math.log10(rms) : -60;
		return db < gateDb;
	}

	encodeWAV(samples: Float32Array, sampleRate: number): ArrayBuffer {
		const buffer = new ArrayBuffer(44 + samples.length * 2);
		const view = new DataView(buffer);
		const writeString = (view: DataView, offset: number, string: string) => {
			for (let i = 0; i < string.length; i++) {
				view.setUint8(offset + i, string.charCodeAt(i));
			}
		};
		writeString(view, 0, 'RIFF');
		view.setUint32(4, 36 + samples.length * 2, true);
		writeString(view, 8, 'WAVE');
		writeString(view, 12, 'fmt ');
		view.setUint32(16, 16, true);
		view.setUint16(20, 1, true); // PCM
		view.setUint16(22, 1, true); // Mono
		view.setUint32(24, sampleRate, true);
		view.setUint32(28, sampleRate * 2, true);
		view.setUint16(32, 2, true);
		view.setUint16(34, 16, true);
		writeString(view, 36, 'data');
		view.setUint32(40, samples.length * 2, true);
		let offset = 44;
		for (let i = 0; i < samples.length; i++, offset += 2) {
			const val = samples[i];
			if (val !== undefined) {
				const s = Math.max(-1, Math.min(1, val));
				view.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7FFF, true);
			}
		}
		return buffer;
	}

	async startLiveSession(micId: string) {
		if (this.session && this.session.status !== 'idle') {
			new Notice('A live session is already running.');
			return;
		}

		const now = new Date();
		const timestamp = now.toISOString().replace(/[:.]/g, '-').slice(0, 19);
		const sessionId = `live-${timestamp}`;

		const adapter = this.app.vault.adapter as any;

		const folderPath = this.app.vault.configDir + '/plugins/local-transcriber/tmp/';
		const sessionDirPath = `${folderPath}${sessionId}/`;

		if (!await adapter.exists(folderPath.replace(/\/$/, ''))) {
			await adapter.mkdir(folderPath.replace(/\/$/, ''));
		}
		if (!await adapter.exists(sessionDirPath.replace(/\/$/, ''))) {
			await adapter.mkdir(sessionDirPath.replace(/\/$/, ''));
		}
		if (!await adapter.exists(`${sessionDirPath}chunks/`.replace(/\/$/, ''))) {
			await adapter.mkdir(`${sessionDirPath}chunks/`.replace(/\/$/, ''));
		}

		let userRawPath = undefined;
		if (this.plugin.settings.liveKeepRawAudio) {
			const outFolder = this.plugin.settings.liveOutputFolder || 'Live_Transcripts/';
			const userFolder = outFolder.endsWith('/') ? outFolder : outFolder + '/';
			if (!await adapter.exists(userFolder.replace(/\/$/, ''))) {
				await this.app.vault.createFolder(userFolder.replace(/\/$/, ''));
			}
			userRawPath = `${userFolder}${sessionId}.wav`;
		}

		this.session = {
			id: sessionId,
			startedAt: timestamp,
			status: 'recording',
			micDeviceId: micId,
			model: this.plugin.settings.liveModelSize || 'python-whisper::base.en',
			language: this.plugin.settings.liveLanguage || 'en',
			speakers: this.plugin.settings.liveDiarizationMode || 'finalize',
			chunkSeconds: this.plugin.settings.liveChunkSeconds || 3,
			overlapSeconds: this.plugin.settings.liveChunkOverlapSeconds || 0.75,
			sessionDir: sessionDirPath,
			rawAudioPath: userRawPath,
			chunksProcessed: 0,
			transcriptSegments: [],
			nextSubtitleIndex: 1
		};
		this.failedChunks = [];

		this.modal?.setRecordingState('recording');
		this.modal?.log('Starting live transcription session...');

		await this.plugin.liveSessionManager.initSessionNote(this.session);

		try {
			this.mediaStream = await navigator.mediaDevices.getUserMedia({ audio: { deviceId: micId } });
			this.audioContext = new AudioContext({ sampleRate: this.sampleRate });
			this.sourceNode = this.audioContext.createMediaStreamSource(this.mediaStream);

			this.processor = this.audioContext.createScriptProcessor(4096, 1, 1);
			this.recordedSamples = [];
			this.recordingOffset = 0;

			const samplesPerChunk = this.session.chunkSeconds * this.sampleRate;
			const overlapSamples = this.session.overlapSeconds * this.sampleRate;

			this.processor.onaudioprocess = (e) => {
				if (!this.session || this.session.status !== 'recording') return;

				const inputData = e.inputBuffer.getChannelData(0);
				const dataCopy = new Float32Array(inputData.length);
				dataCopy.set(inputData);
				this.recordedSamples.push(dataCopy);

				const totalSamplesSoFar = this.recordedSamples.reduce((acc, val) => acc + val.length, 0);

				if (totalSamplesSoFar - this.recordingOffset >= samplesPerChunk) {
					this.extractAndQueueChunk(this.recordingOffset, samplesPerChunk);
					this.recordingOffset += (samplesPerChunk - overlapSamples);
				}

				if (totalSamplesSoFar % this.sampleRate < inputData.length) {
					this.updateModalProgress();
				}
			};

			this.sourceNode.connect(this.processor);
			this.processor.connect(this.audioContext.destination);

			this.plugin.statusBarItem.setText('🎙 Dictating...');

		} catch (err: any) {
			this.modal?.log(`Failed to start recording: ${err.message}`);
			this.session = null;
		}
	}

	updateModalProgress(isFinalizing: boolean = false) {
		if (!this.session || !this.modal) return;

		const totalSamplesSoFar = this.recordedSamples.reduce((acc, val) => acc + val.length, 0);
		const recordedSeconds = totalSamplesSoFar / this.sampleRate;

		const effectiveChunkAdvance = this.session.chunkSeconds - this.session.overlapSeconds;
		let transcribedSeconds = this.session.chunksProcessed * effectiveChunkAdvance;

		if (transcribedSeconds > recordedSeconds) {
			transcribedSeconds = recordedSeconds;
		}

		this.modal.setTranscriptionProgress(
			recordedSeconds,
			transcribedSeconds,
			this.isProcessingChunk,
			isFinalizing
		);
	}

	async extractAndQueueChunk(startOffset: number, length: number) {
		if (!this.session) return;

		const totalSamplesSoFar = this.recordedSamples.reduce((acc, val) => acc + val.length, 0);
		const flatSamples = new Float32Array(totalSamplesSoFar);
		let offset = 0;
		for (const arr of this.recordedSamples) {
			flatSamples.set(arr, offset);
			offset += arr.length;
		}

		const chunkSamples = flatSamples.slice(startOffset, startOffset + length);

		let discardSamples = startOffset;
		while (this.recordedSamples.length > 0) {
			const first = this.recordedSamples[0];
			if (first && discardSamples >= first.length) {
				discardSamples -= first.length;
				this.recordedSamples.shift();
			} else {
				break;
			}
		}
		this.recordingOffset -= startOffset;

		const isSilent = this.isSamplesSilent(chunkSamples, this.plugin.settings.liveSilenceGateDb || -40);
		const chunkIndex = this.session.chunksProcessed + this.chunkQueue.length;

		const adapter = this.app.vault.adapter as any;
		const basePath = adapter.getBasePath();
		const chunkFilename = `chunk-${chunkIndex.toString().padStart(5, '0')}.wav`;
		const chunkFilePath = path.join(basePath, this.session.sessionDir, 'chunks', chunkFilename);

		const wavBuffer = this.encodeWAV(chunkSamples, this.sampleRate);
		fs.writeFileSync(chunkFilePath, Buffer.from(wavBuffer));

		if (isSilent) {
			this.modal?.log(`Chunk ${chunkIndex} below silence threshold, skipping transcription.`);
			this.session.chunksProcessed++;
		} else {
			this.chunkQueue.push(chunkFilePath);

			if (!this.isProcessingChunk) {
				this.processNextChunk();
			}
		}

		this.updateModalProgress();
	}

	pauseLiveSession() {
		if (!this.session || this.session.status !== 'recording') return;
		this.session.status = 'paused';
		this.modal?.setRecordingState('paused');
		this.modal?.log('Dictation paused.');
		this.plugin.statusBarItem.setText('⏸ Dictation Paused');
	}

	async resumeLiveSession() {
		if (!this.session || this.session.status !== 'paused') return;
		this.session.status = 'recording';
		this.modal?.setRecordingState('recording');
		this.modal?.log('Dictation resumed.');
		this.plugin.statusBarItem.setText('🎙 Dictating...');
	}

	async stopLiveSession() {
		if (!this.session || this.session.status === 'idle') return;

		this.session.status = 'stopping';
		this.modal?.log('Stopping recording...');

		if (this.processor) {
			this.processor.disconnect();
			this.processor = null;
		}
		if (this.sourceNode) {
			this.sourceNode.disconnect();
			this.sourceNode = null;
		}
		if (this.audioContext) {
			await this.audioContext.close();
			this.audioContext = null;
		}
		if (this.mediaStream) {
			this.mediaStream.getTracks().forEach((t: any) => t.stop());
			this.mediaStream = null;
		}

		if (this.recordedSamples.length > 0) {
			const totalSamplesSoFar = this.recordedSamples.reduce((acc, val) => acc + val.length, 0);
			if (totalSamplesSoFar - this.recordingOffset > this.sampleRate) {
				await this.extractAndQueueChunk(this.recordingOffset, totalSamplesSoFar - this.recordingOffset);
			}
		}

		this.modal?.setRecordingState('idle');
		this.modal?.log('Live session stopping... waiting for transcription to finish.');
		this.plugin.statusBarItem.setText('⏳ Finalizing dictation...');

		while (this.chunkQueue.length > 0 || this.isProcessingChunk) {
			this.updateModalProgress(true);
			await new Promise(resolve => setTimeout(resolve, 500));
		}

		this.updateModalProgress(true);

		const rawAudioPath = this.session.rawAudioPath;
		const sessionDir = this.session.sessionDir;

		this.modal?.log('Live session stopped.');
		this.plugin.statusBarItem.setText('');

		if (rawAudioPath && this.recordedSamples.length > 0) {
			const { Modal, Setting } = require('obsidian');
			const promptModal = new Modal(this.app);
			promptModal.titleEl.setText('Keep recording?');
			promptModal.contentEl.setText('Do you want to save the raw audio recording of this dictation?');
			new Setting(promptModal.contentEl)
				.addButton((btn: any) => btn.setButtonText('Delete').onClick(async () => {
					promptModal.close();
					await this.cleanupSessionTempDir(sessionDir);
				}))
				.addButton((btn: any) => btn.setButtonText('Keep').setCta().onClick(async () => {
					promptModal.close();
					const totalSamplesSoFar = this.recordedSamples.reduce((acc, val) => acc + val.length, 0);
					const flatSamples = new Float32Array(totalSamplesSoFar);
					let offset = 0;
					for (const arr of this.recordedSamples) {
						flatSamples.set(arr, offset);
						offset += arr.length;
					}
					const wavBuffer = this.encodeWAV(flatSamples, this.sampleRate);
					const adapter = this.app.vault.adapter as any;
					const basePath = adapter.getBasePath();
					const fullRawPath = path.join(basePath, rawAudioPath);
					fs.writeFileSync(fullRawPath, Buffer.from(wavBuffer));
					new Notice(`Saved dictation audio to ${rawAudioPath}`);
					await this.cleanupSessionTempDir(sessionDir, [path.basename(rawAudioPath)]);
				}));
			promptModal.open();
		} else {
			await this.cleanupSessionTempDir(sessionDir);
		}

		this.session = null;
		this.recordedSamples = [];
		this.chunkQueue = [];
		this.isProcessingChunk = false;
	}

	async cleanupSessionTempDir(sessionDir: string, keepFiles: string[] = []) {
		const adapter = this.app.vault.adapter as any;
		try {
			if (await adapter.exists(sessionDir)) {
				const list = await adapter.list(sessionDir);
				for (const folder of list.folders) {
					await adapter.rmdir(folder, true);
				}
				for (const file of list.files) {
					if (!keepFiles.includes(path.basename(file))) {
						await adapter.remove(file);
					}
				}
				if (keepFiles.length === 0) {
					await adapter.rmdir(sessionDir, true);
				}
			}
		} catch (e) {
			console.error("Cleanup failed", e);
		}
	}

	async processNextChunk() {
		if (this.chunkQueue.length === 0 || !this.session) {
			this.isProcessingChunk = false;
			return;
		}

		this.isProcessingChunk = true;
		const chunkPath = this.chunkQueue.shift()!;

		const chunkIndex = this.session.chunksProcessed;
		const chunkStartTime = chunkIndex * (this.session.chunkSeconds - this.session.overlapSeconds);

		try {
			this.modal?.log(`Processing chunk ${chunkIndex}...`);
			const result: any = await this.processChunk(chunkPath, chunkStartTime);

			if (result && result.segments && result.segments.length > 0) {
				const normalizedSegments = result.segments.map((s: any) => ({
					...s,
					start: s.start + chunkStartTime,
					end: s.end + chunkStartTime
				}));

				const newSegments = this.plugin.liveSessionManager.deduplicateSegments(
					this.session.transcriptSegments,
					normalizedSegments
				);

				if (newSegments.length > 0) {
					for (const seg of newSegments) {
						this.session.transcriptSegments.push(seg);
						this.insertLiveChunkAtCursor(seg.text);
						this.modal?.setPreviewText(seg.text);
					}
				}
			}
		} catch (err: any) {
			this.modal?.log(`Error processing chunk: ${err.message}`);
			this.failedChunks.push(path.basename(chunkPath));
		} finally {
			if (this.session) {
				this.session.chunksProcessed++;
				this.updateModalProgress();
				if (this.session.status !== 'idle') {
					this.processNextChunk();
				} else {
					this.isProcessingChunk = false;
				}
			} else {
				this.isProcessingChunk = false;
			}
		}
	}

	formatDictationInsertion(text: string, editor: any): string {
		if (!text) return "";
		let out = text.replace(/\s+/g, " ").trim();

		const cursor = editor.getCursor();
		const line = editor.getLine(cursor.line);
		const before = cursor.ch > 0 ? line[cursor.ch - 1] : "";

		const needsLeadingSpace =
			out.length > 0 &&
			before &&
			!/\s/.test(before) &&
			!/^[,.;:!?)]/.test(out);

		if (needsLeadingSpace) out = " " + out;

		const needsTrailingSpace =
			out.length > 0 &&
			!/\s$/.test(out);

		if (needsTrailingSpace) out += " ";

		return out;
	}

	insertLiveChunkAtCursor(text: string) {
		const { MarkdownView } = require('obsidian');
		const view = this.app.workspace.getActiveViewOfType(MarkdownView) as any;
		if (!view || !view.editor) return;

		const editor = view.editor;
		const cursor = editor.getCursor();

		const insertText = this.formatDictationInsertion(text, editor);
		if (!insertText) return;

		editor.replaceRange(insertText, cursor);

		const lines = insertText.split('\n');
		const lastLine = lines[lines.length - 1] || '';
		if (lines.length === 1) {
			editor.setCursor({ line: cursor.line, ch: cursor.ch + lastLine.length });
		} else {
			editor.setCursor({
				line: cursor.line + lines.length - 1,
				ch: lastLine.length
			});
		}
	}

	async processChunk(chunkPath: string, chunkStart: number): Promise<unknown> {
		if (!this.session) throw new Error("No session");

		const fullModelId = this.session.model;
		const backendStr = fullModelId.split('::')[0];
		const modelId = fullModelId.split('::').slice(1).join('::');

		const modelsDir = this.plugin.pythonEnv.getModelsDir();

		const options = {
			chunkPath,
			modelId,
			language: this.session.language,
			modelsDir,
			chunkStart,
			sessionId: this.session.id
		};

		const onEvent = (msg: any) => {};

		if (backendStr === 'python-whisper') {
			const backend = new PythonWhisperLiveBackend(this.plugin);
			return backend.transcribeChunk(options, onEvent);
		} else if (backendStr === 'ollama') {
			const backend = new OllamaLiveBackend(this.plugin);
			return backend.transcribeChunk(options, onEvent);
		}

		throw new Error("Unknown backend");
	}
}
