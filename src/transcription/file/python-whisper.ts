import { App } from 'obsidian';
import * as path from 'path';
import { spawn } from 'child_process';
import { FileTranscriptionBackend, FileTranscriptionOptions, TranscriptionEvent, Segment } from '../events';
import LocalTranscriberPlugin from '../../main';

export class PythonWhisperFileBackend implements FileTranscriptionBackend {
    constructor(private plugin: LocalTranscriberPlugin) {}

    async transcribeFile(options: FileTranscriptionOptions, onEvent: (event: TranscriptionEvent) => void): Promise<{ segments: Segment[] }> {
        return new Promise((resolve, reject) => {
            const app = this.plugin.app;
			const adapter: any = app.vault.adapter;
			const vaultPath = adapter && adapter.getBasePath ? adapter.getBasePath() : '';
			const pluginDir = path.join(vaultPath, app.vault.configDir, 'plugins', 'local-transcriber');
			const transcribeScript = path.join(pluginDir, 'local_transcriber', 'transcribe.py');
			const pyPath = this.plugin.pythonEnv.getPythonExecutable();

			console.log("[local-transcriber] Whisper backend", {
				backend: "python-whisper",
				model: options.modelId,
				wordTimestamps: options.wordTimestamps,
				language: options.language,
			});

			const startTime = Date.now();
			let lastOutputTime = Date.now();

			const args = [
				transcribeScript,
				'--input', options.inputPath,
				'--model', options.modelId,
				'--language', options.language,
				'--speakers', options.speakers,
				'--models-dir', options.modelsDir || ''
			];

			console.log("[python-whisper] Spawning Whisper worker", { pythonExe: pyPath, args, cwd: pluginDir });

			const child = spawn(pyPath, args, {
				env: { ...process.env },
				cwd: pluginDir,
			});

			console.log("[local-transcriber] Worker started", { kind: "whisper", pid: child.pid });

			let finalJson = '';
			let rawStdout = '';
            let segments: Segment[] = [];

			const stallTimeoutMs = 120000; // 2 minutes
			const stallCheckInterval = setInterval(() => {
				if (Date.now() - lastOutputTime > stallTimeoutMs) {
					console.warn("[local-transcriber] Worker stalled", { kind: "whisper", elapsedMs: Date.now() - startTime });
					console.error("[local-transcriber] Worker force-killed", { kind: "whisper", pid: child.pid });
					child.kill('SIGKILL');
					clearInterval(stallCheckInterval);
					reject(new Error('Whisper worker stalled (no output for 2 mins).'));
				}
			}, 10000);

			const onAbort = () => {
				console.log("[local-transcriber] Cancelling worker", { kind: "whisper", pid: child.pid });
				child.kill('SIGTERM');
				setTimeout(() => {
					if (!child.killed) {
						console.warn("[local-transcriber] Worker did not exit gracefully, forcing kill", { kind: "whisper", pid: child.pid });
						child.kill('SIGKILL');
					}
				}, 2000);
			};

			if ((options as any).signal) {
				if ((options as any).signal.aborted) {
					onAbort();
				} else {
					(options as any).signal.addEventListener('abort', onAbort);
				}
			}

			child.stdout.on('data', (chunk) => {
				const text = chunk.toString();
				rawStdout += text;
				lastOutputTime = Date.now();
				const lines = text.split('\n').filter((l: string) => l.trim());
				for (const line of lines) {
					if (line.startsWith('{')) {
						try {
							const msg = JSON.parse(line);
                            msg.backend = 'python-whisper';
                            onEvent(msg);

                            if (msg.type === 'segment') {
                                segments.push(msg);
                            } else if (msg.type === 'result') {
                                finalJson = line;
                                if (msg.segments) segments = msg.segments;
                            }
						} catch {
						}
					}
				}
			});

			let stderrOutput = '';
			child.stderr.on('data', (data) => {
				stderrOutput += data.toString();
				lastOutputTime = Date.now();
			});

			child.on('close', (code) => {
				clearInterval(stallCheckInterval);
				if ((options as any).signal) {
					(options as any).signal.removeEventListener('abort', onAbort);
				}

				if ((options as any).signal?.aborted) {
					console.log("[local-transcriber] Worker terminated", { kind: "whisper", reason: "cancelled" });
					reject(new Error("Cancelled"));
					return;
				}

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
						resolve({ segments: parsed.segments || segments });
						return;
					} catch {
					}
				}

				resolve({ segments });
			});
        });
    }
}
