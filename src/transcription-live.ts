import { App, Notice } from 'obsidian';
import LocalTranscriberPlugin from './main';
import { LiveTranscribeModal } from './ui/live-modal';
import { LiveTranscriptionSession, LiveSegment } from './live-session';
import * as path from 'path';
import * as fs from 'fs';
import { spawn } from 'child_process';

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
					await this.plugin.environment.setupWhisperEnvironment({
						log: (msg) => console.log(`[Dictation] ${msg}`),
						setStage: (stage) => console.log(`[Dictation Stage] ${stage}`)
					});
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

		// Use a temp path outside the vault where possible, or a hidden plugin temp subfolder.
		// Since we use vault adapters, let's use a hidden plugin folder.
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
			model: this.plugin.settings.liveModelSize || 'base.en',
			language: this.plugin.settings.liveLanguage || 'en',
			speakers: this.plugin.settings.liveDiarizationMode || 'finalize',
			chunkSeconds: this.plugin.settings.liveChunkSeconds || 10,
			overlapSeconds: this.plugin.settings.liveChunkOverlapSeconds || 2,
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

		// Setup PCM capture
		try {
			this.mediaStream = await navigator.mediaDevices.getUserMedia({ audio: { deviceId: micId } });
			this.audioContext = new AudioContext({ sampleRate: this.sampleRate });
			this.sourceNode = this.audioContext.createMediaStreamSource(this.mediaStream);

			// Use ScriptProcessorNode for wide compatibility and direct PCM access
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
					// We have enough data for a chunk
					this.extractAndQueueChunk(this.recordingOffset, samplesPerChunk);

					// Advance the offset by chunk - overlap
					this.recordingOffset += (samplesPerChunk - overlapSamples);
				}

				// Update progress roughly every ~1 second worth of samples to avoid UI locking
				if (totalSamplesSoFar % this.sampleRate < inputData.length) {
					this.updateModalProgress();
				}
			};

			this.sourceNode.connect(this.processor);
			this.processor.connect(this.audioContext.destination); // Required for script processor to work

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

		// Ensure transcribed doesn't exceed recorded, which can happen slightly due to last chunk boundaries
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

		// Flatten recorded samples
		const totalSamplesSoFar = this.recordedSamples.reduce((acc, val) => acc + val.length, 0);
		const flatSamples = new Float32Array(totalSamplesSoFar);
		let offset = 0;
		for (const arr of this.recordedSamples) {
			flatSamples.set(arr, offset);
			offset += arr.length;
		}

		const chunkSamples = flatSamples.slice(startOffset, startOffset + length);

		// Discard very old samples to prevent unbounded memory growth
		// We keep up to the current startOffset
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
		this.recordingOffset -= startOffset; // Adjust offset relative to the new start of recordedSamples

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

		// Extract any remaining audio as final chunk
		if (this.recordedSamples.length > 0) {
			const totalSamplesSoFar = this.recordedSamples.reduce((acc, val) => acc + val.length, 0);
			if (totalSamplesSoFar - this.recordingOffset > this.sampleRate) { // At least 1 second
				await this.extractAndQueueChunk(this.recordingOffset, totalSamplesSoFar - this.recordingOffset);
			}
		}

		this.modal?.setRecordingState('idle');
		this.modal?.log('Live session stopping... waiting for transcription to finish.');
		this.plugin.statusBarItem.setText('⏳ Finalizing dictation...');

		// Wait for the chunk queue to drain and processing to complete
		while (this.chunkQueue.length > 0 || this.isProcessingChunk) {
			this.updateModalProgress(true);
			await new Promise(resolve => setTimeout(resolve, 500));
		}

		this.updateModalProgress(true);

		const rawAudioPath = this.session.rawAudioPath;
		const sessionDir = this.session.sessionDir;

		this.modal?.log('Live session stopped.');
		this.plugin.statusBarItem.setText('');

		// Prompt to keep or delete raw audio
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

		// Reset state
		this.session = null;
		this.recordedSamples = [];
		this.chunkQueue = [];
		this.isProcessingChunk = false;
	}

	async cleanupSessionTempDir(sessionDir: string, keepFiles: string[] = []) {
		const adapter = this.app.vault.adapter as any;
		try {
			if (await adapter.exists(sessionDir)) {
				// Delete chunks and everything not in keepFiles
				// This is a naive cleanup for a temp dir.
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

	async writeSessionJson(session: LiveTranscriptionSession) {
		const adapter = this.app.vault.adapter as any;
		const basePath = adapter.getBasePath();
		const sessionJsonPath = path.join(basePath, session.sessionDir, 'session.json');
		const data = {
			id: session.id,
			startedAt: session.startedAt,
			model: session.model,
			language: session.language,
			speakers: session.speakers,
			chunkSeconds: session.chunkSeconds,
			overlapSeconds: session.overlapSeconds,
			failedChunks: this.failedChunks,
			chunksProcessed: session.chunksProcessed
		};
		fs.writeFileSync(sessionJsonPath, JSON.stringify(data, null, 2));
	}

	async processNextChunk() {
		if (this.chunkQueue.length === 0 || !this.session) {
			this.isProcessingChunk = false;
			return;
		}

		this.isProcessingChunk = true;
		const chunkPath = this.chunkQueue.shift()!;

		const chunkIndex = this.session.chunksProcessed;
		// Absolute time offset calculation
		const chunkStartTime = chunkIndex * (this.session.chunkSeconds - this.session.overlapSeconds);

		try {
			this.modal?.log(`Processing chunk ${chunkIndex}...`);
			const result: any = await this.processChunk(chunkPath, chunkStartTime);

			if (result && result.segments && result.segments.length > 0) {
				// Normalize timestamps relative to session start
				const normalizedSegments = result.segments.map((s: any) => ({
					...s,
					start: s.start + chunkStartTime,
					end: s.end + chunkStartTime
				}));

				// Deduplicate
				const newSegments = this.plugin.liveSessionManager.deduplicateSegments(
					this.session.transcriptSegments,
					normalizedSegments
				);

				if (newSegments.length > 0) {
					for (const seg of newSegments) {
						this.session.transcriptSegments.push(seg);

						// We no longer preview in the modal or append to files directly here.
						// Instead, we will insert it directly at the cursor position.
						this.insertLiveChunkAtCursor(seg.text);

						// Update the modal preview with the latest text
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
				// If not stopping, process next
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

		// Move cursor to the end of the inserted text
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

		return new Promise((resolve, reject) => {
			const adapter: any = this.app.vault.adapter;
			const vaultPath = adapter && adapter.getBasePath ? adapter.getBasePath() : '';
			const pluginDir = path.join(vaultPath, this.app.vault.configDir, 'plugins', 'local-transcriber');
			const transcribeScript = path.join(pluginDir, 'local_transcriber', 'transcribe_live.py');
			const modelsDir = this.plugin.environment.getModelsDir();

			const pyPath = this.plugin.environment.getPythonExecutable();

			const args = [
				transcribeScript,
				'--input', chunkPath,
				'--model', this.session?.model || '',
				'--language', this.session?.language || '',
				'--models-dir', modelsDir,
				'--chunk-start', chunkStart.toString(),
				'--session-id', this.session?.id || '',
				'--output-format', 'jsonl',
				'--no-diarization', // Diarization disabled for dictation
				'--input-is-normalized-wav'
			];

			const child = spawn(pyPath, args);

			let finalJson = '';
			let rawStdout = '';
			let stderrOutput = '';
			let segments: any[] = [];

			if (child.stdout) {
				child.stdout.on('data', (chunk) => {
					const text = chunk.toString();
					rawStdout += text;
					const lines = text.split('\n').filter((l: string) => l.trim());
					for (const line of lines) {
						if (line.startsWith('{')) {
							try {
								const msg = JSON.parse(line);
								if (msg.type === 'segment') {
									segments.push(msg);
								} else if (msg.type === 'result') {
									finalJson = line;
								}
							} catch {}
						}
					}
				});
			}

			if (child.stderr) {
				child.stderr.on('data', (data) => {
					stderrOutput += data.toString();
				});
			}

			child.on('close', (code) => {
				if (code !== 0) {
					reject(new Error(`Process failed with code ${code}.\n${stderrOutput || 'No stderr.'}`));
					return;
				}

				if (finalJson) {
					try {
						const parsed = JSON.parse(finalJson);
						if (parsed && parsed.error) {
							reject(new Error(parsed.error));
							return;
						}
						// Use collected segments instead of batch parsed
						if (parsed) {
							resolve({ ...parsed, segments });
							return;
						}
					} catch {}
				}

				resolve({ segments });
			});
		});
	}
}
