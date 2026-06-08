import { App, Notice, WorkspaceLeaf } from 'obsidian';
import LocalTranscriberPlugin from './main';
import { VIEW_TYPE_LIVE_DICTATION, LiveDictationView } from './ui/live-modal';
import { LiveTranscriptionSession } from './live-session';
import { WhisperServerBackend } from './transcription/live/whisper-server-backend';
import * as path from 'path';
import * as fs from 'fs';

export class TranscriptionLive {
	plugin: LocalTranscriberPlugin;
	app: App;

	private session: LiveTranscriptionSession | null = null;
	private whisperServer: WhisperServerBackend | null = null;
	private modal: LiveDictationView | null = null;

	private audioContext: AudioContext | null = null;
	private mediaStream: MediaStream | null = null;
	private processor: ScriptProcessorNode | null = null;
	private sourceNode: MediaStreamAudioSourceNode | null = null;
	private chunkBufferSamples: Float32Array[] = [];
	private isProcessingChunk: boolean = false;
	private totalRecordedSamplesCount: number = 0;
	private statusBarTimer: number | null = null;
	private totalTranscribedSeconds: number = 0;

	constructor(plugin: LocalTranscriberPlugin) {
		this.plugin = plugin;
		this.app = plugin.app;
	}

	async handleTranscribeLive(view: LiveDictationView) {
		this.modal = view;
		this.modal.onStartClick(async (micId: string) => await this.startRecording(micId));
		this.modal.onPauseClick(() => this.pauseRecording());
		this.modal.onStopClick(async () => await this.stopRecording());
	}

	async startRecording(micId: string) {
		if (this.session) await this.stopRecording();

		const now = new Date();
		const timestamp = now.toISOString().replace(/[:.]/g, '-').slice(0, 19);
		const sessionId = `live-${timestamp}`;
		const sessionDirPath = `${this.app.vault.configDir}/plugins/local-transcriber/tmp/${sessionId}/`;
		
		const adapter = this.app.vault.adapter as any;
		await adapter.mkdir(sessionDirPath + 'chunks/');

		this.session = {
			id: sessionId,
			status: 'recording',
			model: this.plugin.settings.liveModelSize || 'faster-whisper::base',
			language: this.plugin.settings.liveLanguage || 'en',
			sessionDir: sessionDirPath,
			chunksProcessed: 0
		} as any;

		const [backendStr, modelName] = this.session!.model.split('::');
		if (backendStr === 'faster-whisper') {
			this.whisperServer = new WhisperServerBackend(this.plugin);
			try {
				console.log(`[TranscriptionLive] Starting WhisperServer with model="${modelName || 'base'}"...`);
				await this.whisperServer.start(modelName || "base", this.session!.language);
				console.log(`[TranscriptionLive] WhisperServer started successfully`);
			} catch (err: any) {
				console.error(`[TranscriptionLive] WhisperServer failed to start: ${err.message}`);
				// Clean up the partially-started session
				this.session = null;
				this.whisperServer = null;
				this.modal?.setRecordingState('idle');
				// Show the user a clear error notice
				const { Notice } = require('obsidian');
				new Notice(`Transcription failed to start: ${err.message}`, 8000);
				return; // Do NOT continue to set up audio capture
			}
		}

		this.totalTranscribedSeconds = 0;

		this.mediaStream = await navigator.mediaDevices.getUserMedia({ audio: { deviceId: micId } });
		this.audioContext = new AudioContext({ sampleRate: 16000 });
		this.sourceNode = this.audioContext.createMediaStreamSource(this.mediaStream);
		this.processor = this.audioContext.createScriptProcessor(4096, 1, 1);
		this.totalRecordedSamplesCount = 0;

		this.processor.onaudioprocess = (e) => {
			if (!this.session || this.session.status !== 'recording') return;
			const inputData = e.inputBuffer.getChannelData(0);
			this.chunkBufferSamples.push(new Float32Array(inputData));
			this.totalRecordedSamplesCount += inputData.length;
			if (this.chunkBufferSamples.length > (16000 * 5) / 4096) {
				// Guard: only extract if server is actually ready
				if (!this.whisperServer?.isReady) {
					console.warn('[TranscriptionLive] onaudioprocess — skipping chunk, server not ready');
					this.chunkBufferSamples = []; // discard buffered audio
					return;
				}
				// Catch and log async errors so they don't leak as uncaught rejections
				this.extractChunk().catch(err => {
					console.error('[TranscriptionLive] extractChunk failed:', err.message);
				});
			}
		};

		this.sourceNode.connect(this.processor);
		this.processor.connect(this.audioContext.destination);
		this.modal?.setRecordingState('recording');

		this.statusBarTimer = window.setInterval(() => {
			if (this.session && this.session.status === 'recording') {
				const elapsed = Math.floor(this.totalRecordedSamplesCount / 16000);
				const m = Math.floor(elapsed / 60);
				const s = elapsed % 60;
				this.plugin.statusBarItem.setText(`🎙 REC ${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`);
			}
		}, 1000);
	}

	async extractChunk() {
		if (this.isProcessingChunk || !this.session) return;
		this.isProcessingChunk = true;

		const samples = new Float32Array(this.chunkBufferSamples.reduce((a, b) => a + b.length, 0));
		let offset = 0;
		for (const buf of this.chunkBufferSamples) { samples.set(buf, offset); offset += buf.length; }
		this.chunkBufferSamples = [];

		const rms = Math.sqrt(samples.reduce((sum, s) => sum + s * s, 0) / samples.length);
		const SILENCE_RMS_THRESHOLD = 0.001; // was 0.005 — lowered for typical mic gain levels
		const MIN_CHUNK_DURATION_SECS = 1.0;
		const chunkDurationSecs = samples.length / 16000;
		console.log(`[TranscriptionLive] Chunk energy RMS=${rms.toFixed(5)}, duration=${chunkDurationSecs.toFixed(2)}s`);

		if (chunkDurationSecs < MIN_CHUNK_DURATION_SECS || rms < SILENCE_RMS_THRESHOLD) {
			console.warn(`[TranscriptionLive] Skipping chunk — duration=${chunkDurationSecs.toFixed(2)}s, RMS=${rms.toFixed(5)} (threshold=${SILENCE_RMS_THRESHOLD})`);
			this.isProcessingChunk = false;
			return;
		}

		const adapter = this.app.vault.adapter as any;
		const chunkPath = path.join(adapter.getBasePath(), this.session.sessionDir, `chunks/chunk-${Date.now()}.wav`);
		fs.writeFileSync(chunkPath, Buffer.from(this.encodeWAV(samples, 16000)));

		try {
			const chunkStartSeconds = this.totalTranscribedSeconds;
			const chunkDurationSeconds = samples.length / 16000;
			this.totalTranscribedSeconds += chunkDurationSeconds;
			console.log(`[TranscriptionLive] Sending chunk: start=${chunkStartSeconds.toFixed(2)}s, duration=${chunkDurationSeconds.toFixed(2)}s, samples=${samples.length}`);

			const result: any = await this.whisperServer!.transcribeChunk(
				{ chunkPath, chunkStart: chunkStartSeconds, sessionId: this.session.id },
				(event) => {
					if (event.type === 'segment') this.modal?.setPreviewText(event.text);
				}
			);
			if (result?.segments) {
				for (const seg of result.segments) {
					this.insertLiveChunkAtCursor(seg.text);
				}
			}
			this.session.chunksProcessed++;
			this.updateProgress();
		} finally {
			this.isProcessingChunk = false;
		}
	}

	encodeWAV(samples: Float32Array, sampleRate: number): ArrayBuffer {
		const buffer = new ArrayBuffer(44 + samples.length * 2);
		const view = new DataView(buffer);
		const writeString = (v: DataView, o: number, s: string) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
		writeString(view, 0, 'RIFF'); view.setUint32(4, 36 + samples.length * 2, true);
		writeString(view, 8, 'WAVE'); writeString(view, 12, 'fmt '); view.setUint32(16, 16, true);
		view.setUint16(20, 1, true); view.setUint16(22, 1, true); view.setUint32(24, sampleRate, true);
		view.setUint32(28, sampleRate * 2, true); view.setUint16(32, 2, true); view.setUint16(34, 16, true);
		writeString(view, 36, 'data'); view.setUint32(40, samples.length * 2, true);
		for (let i = 0; i < samples.length; i++) {
			const rawVal = samples[i];
			const s = (rawVal !== undefined) ? rawVal : 0;
			const clamped = Math.max(-1, Math.min(1, s));
			view.setInt16(44 + i * 2, Math.floor(clamped * 0x7FFF), true);
		}
		return buffer;
	}

	updateProgress() {
		if (!this.session || !this.modal) return;
		this.modal.setTranscriptionProgress(
			this.totalRecordedSamplesCount / 16000,
			this.session.chunksProcessed * 5,
			this.isProcessingChunk
		);
	}

	insertLiveChunkAtCursor(text: string) {
		const { MarkdownView } = require('obsidian');
		const view = this.app.workspace.getActiveViewOfType(MarkdownView) as any;
		if (!view || !view.editor) return;

		const editor = view.editor;
		const cursor = editor.getCursor();
		let out = text.trim() + ' ';
		editor.replaceRange(out, cursor);
		
		const lines = out.split('\n');
		const lastLine = lines[lines.length - 1] || "";
		editor.setCursor({
			line: cursor.line + lines.length - 1,
			ch: (lines.length === 1 ? cursor.ch : 0) + lastLine.length
		});
	}

	async stopRecording() {
		if (this.processor) this.processor.disconnect();
		if (this.whisperServer) await this.whisperServer.shutdown();
		if (this.statusBarTimer) {
			window.clearInterval(this.statusBarTimer);
			this.statusBarTimer = null;
		}
		this.session = null;
		this.modal?.setRecordingState('idle');
		this.plugin.updateStatusBarIcon(false);
	}

	pauseRecording() {
		if (this.session) {
			this.session.status = 'paused';
			this.modal?.setRecordingState('paused');
		}
	}

	isRecording(): boolean { 
		return this.session !== null && this.session.status === 'recording'; 
	}
}
