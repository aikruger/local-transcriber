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

			const child = spawn(pyPath, [
				transcribeScript,
				'--input', options.inputPath,
				'--model', options.modelId,
				'--language', options.language,
				'--speakers', options.speakers,
				'--models-dir', options.modelsDir || ''
			]);

			let finalJson = '';
			let rawStdout = '';
            let segments: Segment[] = [];

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
