import { App } from 'obsidian';
import * as path from 'path';
import * as fs from 'fs';
import { spawn } from 'child_process';
import { FileTranscriptionBackend, FileTranscriptionOptions, TranscriptionEvent, Segment } from '../events';
import LocalTranscriberPlugin from '../../main';

export class PythonWhisperFileBackend implements FileTranscriptionBackend {
    constructor(private plugin: LocalTranscriberPlugin) {}

    async transcribeFile(options: FileTranscriptionOptions, onEvent: (event: TranscriptionEvent) => void): Promise<{ segments: Segment[] }> {
        const app = this.plugin.app;
        const adapter: any = app.vault.adapter;
        const vaultPath = adapter && adapter.getBasePath ? adapter.getBasePath() : '';
        const pluginDir = path.join(vaultPath, app.vault.configDir, 'plugins', this.plugin.manifest.id);
        const transcribeScript = path.join(pluginDir, 'local_transcriber', 'transcribe.py');
        const pyPath = this.plugin.pythonEnv.getPythonExecutable();

        const scriptExists = await fs.promises.access(transcribeScript).then(() => true).catch(() => false);
        console.log('[python-whisper] Resolved script path', {
            scriptPath: transcribeScript,
            scriptExists,
            pythonExe: pyPath,
        });

        if (!scriptExists) {
            throw new Error(`Whisper worker script not found: ${transcribeScript}`);
        }

        const audioExists = await fs.promises.access(options.inputPath).then(() => true).catch(() => false);
        if (!audioExists) {
            throw new Error(`Temporary audio/video file not found: ${options.inputPath}`);
        }

        return new Promise((resolve, reject) => {
            let isSettled = false;

            const safeResolve = (value: { segments: Segment[] }) => {
                if (isSettled) return;
                isSettled = true;
                clearInterval(stallCheckInterval);
                resolve(value);
            };

            const safeReject = (reason: Error) => {
                if (isSettled) return;
                isSettled = true;
                clearInterval(stallCheckInterval);
                reject(reason);
            };

			console.log("[local-transcriber] Whisper backend", {
				backend: "python-whisper",
				model: options.modelId,
				wordTimestamps: options.wordTimestamps,
				language: options.language,
			});

			const args = [
                '-u',
				transcribeScript,
				'--input', options.inputPath,
				'--model', options.modelId,
				'--language', options.language,
				'--speakers', options.speakers,
				'--models-dir', options.modelsDir || ''
			];

            const workerEnv: NodeJS.ProcessEnv = {
                ...process.env,
                PYTHONUNBUFFERED: '1',
                PYTHONIOENCODING: 'utf-8',
                PYTHONPATH: [
                  pluginDir,
                  process.env.PYTHONPATH ?? '',
                ].filter(Boolean).join(path.delimiter),
            };

			console.log("[python-whisper] Worker command", { pythonExe: pyPath, args, cwd: pluginDir, audioPath: options.inputPath, model: options.modelId, env: { PYTHONUNBUFFERED: workerEnv.PYTHONUNBUFFERED, PYTHONIOENCODING: workerEnv.PYTHONIOENCODING, PYTHONPATH: workerEnv.PYTHONPATH } });

			const child = spawn(pyPath, args, {
				env: workerEnv,
				cwd: pluginDir,
                windowsHide: true,
                stdio: ['pipe', 'pipe', 'pipe'],
			});

			console.log("[local-transcriber] Worker started", { kind: "whisper", pid: child.pid });

			let finalJson = '';
			let rawStdout = '';
            let segments: Segment[] = [];
            let lastActivityAt = Date.now();
            let stdoutBuffer = '';
            let stderrBuffer = '';

            const markWorkerActivity = (source: 'stdout' | 'stderr', chunk: Buffer | string) => {
                lastActivityAt = Date.now();
                if (source === 'stderr') {
                    // Reduce noisiness of progress logs on stdout, but log stderr.
                    console.log(`[local-transcriber-whisper] STDERR:`, chunk.toString());
                }
            };

			const STALL_TIMEOUT_MS = 10 * 60 * 1000; // 10 minutes
			const stallCheckInterval = setInterval(() => {
                const idleMs = Date.now() - lastActivityAt;

                if (idleMs <= STALL_TIMEOUT_MS) {
                    return;
                }

                console.error('[local-transcriber] Whisper worker stalled', {
                    kind: 'whisper',
                    pid: child.pid,
                    idleMs,
                    stallTimeoutMs: STALL_TIMEOUT_MS,
                    pythonExe: pyPath,
                    scriptPath: transcribeScript,
                    stdoutTail: stdoutBuffer.slice(-4000),
                    stderrTail: stderrBuffer.slice(-4000),
                });

                child.kill('SIGKILL');
                safeReject(new Error(`Whisper worker stalled: no stdout or stderr for ${Math.round(STALL_TIMEOUT_MS / 60000)} minutes. See the developer console for the Python command and output.`));
			}, 5000);

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
				const text = chunk.toString('utf8');
				stdoutBuffer += text;
                rawStdout += text;
                markWorkerActivity('stdout', chunk);

				const lines = stdoutBuffer.split('\n');
                stdoutBuffer = lines.pop() || ''; // Keep the last incomplete line in the buffer
				for (const line of lines) {
                    const trimmedLine = line.trim();
					if (trimmedLine.startsWith('{')) {
						try {
							const msg = JSON.parse(trimmedLine);
                            msg.backend = 'python-whisper';

                            // Let the frontend parse progress events
                            const isProgress = ['worker_started', 'request_received', 'loading_model', 'model_loaded', 'starting_transcription', 'transcription_started', 'transcription_progress', 'transcription_complete'].includes(msg.type);

                            if (isProgress) {
                                console.log('[python-whisper] Worker progress', msg);
                                // Optionally call onEvent(msg) if frontend understands these
                                continue;
                            }

                            if (msg.type === 'error') {
                                console.error('[python-whisper] Python error event', msg);
                                // Wait for exit, but track it
                            } else if (msg.type === 'segment') {
                                segments.push(msg);
                                onEvent(msg);
                            } else if (msg.type === 'result') {
                                finalJson = trimmedLine;
                                if (msg.segments) segments = msg.segments;
                                onEvent(msg);
                            } else if (msg.type === 'meta') {
                                onEvent(msg);
                            }
						} catch {
						}
					}
				}
			});

			child.stderr.on('data', (data) => {
                stderrBuffer += data.toString('utf8');
				markWorkerActivity('stderr', data);
			});

            child.on('error', (error) => {
                console.error('[local-transcriber] Whisper process spawn error', {
                  error,
                  pythonExe: pyPath,
                  scriptPath: transcribeScript,
                  args,
                  cwd: pluginDir,
                });
                safeReject(error);
            });

			child.on('close', (code) => {
                console.log('[local-transcriber] Whisper worker exited', { code });
				if ((options as any).signal) {
					(options as any).signal.removeEventListener('abort', onAbort);
				}

				if ((options as any).signal?.aborted) {
					console.log("[local-transcriber] Worker terminated", { kind: "whisper", reason: "cancelled" });
					safeReject(new Error("Cancelled"));
					return;
				}

				if (code !== 0) {
					safeReject(new Error(`Process failed with code ${code}.\n${stderrBuffer || 'No stderr.'}`));
					return;
				}

				if (finalJson) {
					try {
						const parsed = JSON.parse(finalJson);
						if (parsed.error) {
							safeReject(new Error(parsed.error));
							return;
						}
						safeResolve({ segments: parsed.segments || segments });
						return;
					} catch {
					}
				}

				safeResolve({ segments });
			});
        });
    }
}
