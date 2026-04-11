import { App } from 'obsidian';
import * as path from 'path';
import { spawn } from 'child_process';
import { LiveTranscriptionBackend, LiveTranscriptionOptions, TranscriptionEvent, Segment } from '../events';
import LocalTranscriberPlugin from '../../main';

export class PythonWhisperLiveBackend implements LiveTranscriptionBackend {
    constructor(private plugin: LocalTranscriberPlugin) {}

    async transcribeChunk(options: LiveTranscriptionOptions, onEvent: (event: TranscriptionEvent) => void): Promise<{ segments: Segment[] }> {
        return new Promise((resolve, reject) => {
            const app = this.plugin.app;
			const adapter: any = app.vault.adapter;
			const vaultPath = adapter && adapter.getBasePath ? adapter.getBasePath() : '';
			const pluginDir = path.join(vaultPath, app.vault.configDir, 'plugins', 'local-transcriber');
			const transcribeScript = path.join(pluginDir, 'local_transcriber', 'transcribe_live.py');
			const pyPath = this.plugin.pythonEnv.getPythonExecutable();

			const args = [
				transcribeScript,
				'--input', options.chunkPath,
				'--model', options.modelId,
				'--language', options.language,
				'--models-dir', options.modelsDir || '',
				'--chunk-start', options.chunkStart.toString(),
				'--session-id', options.sessionId,
				'--output-format', 'jsonl',
				'--no-diarization',
				'--input-is-normalized-wav'
			];

			const child = spawn(pyPath, args);

			let finalJson = '';
			let rawStdout = '';
			let stderrOutput = '';
			let segments: Segment[] = [];

			if (child.stdout) {
				child.stdout.on('data', (chunk) => {
					const text = chunk.toString();
					rawStdout += text;
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
					} catch {}
				}

				resolve({ segments });
			});
        });
    }
}
