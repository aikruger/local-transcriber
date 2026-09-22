import { spawn } from 'child_process';
import * as path from 'path';
import * as fs from 'fs/promises';
import * as fsSync from 'fs';
import { DiarizationOptions, DiarizationBackend } from './types';
import { DiarizationSegment } from '../models/transcript';

export class PyannoteWorker implements DiarizationBackend {
  private pythonExecutable: string;
  private scriptPath: string;
  private pluginDir: string;

  constructor(pythonExecutable: string, pluginDir: string) {
    this.pythonExecutable = pythonExecutable;
    this.pluginDir = pluginDir;
    this.scriptPath = path.join(pluginDir, 'local_transcriber', 'diarize.py');
  }

  async diarize(options: DiarizationOptions): Promise<DiarizationSegment[]> {
    console.log("[local-transcriber] Starting diarisation", {
      audioPath: options.audioPath,
      expectedSpeakers: options.expectedSpeakers,
      backend: "pyannote",
    });

    console.log('[pyannote-worker] Plugin dir', this.pluginDir);
    console.log('[pyannote-worker] Script path', this.scriptPath);

    const exists = await fs
      .access(this.scriptPath, fsSync.constants.F_OK)
      .then(() => true)
      .catch(() => false);

    console.log('[pyannote-worker] Script exists?', exists);

    if (!exists) {
      throw new Error(`Diarization script not found at ${this.scriptPath}`);
    }

    return new Promise((resolve, reject) => {
      const args = ['--audio-path', options.audioPath];

      if (options.expectedSpeakers !== undefined) {
        args.push('--expected-speakers', options.expectedSpeakers.toString());
      } else {
        if (options.minSpeakers !== undefined) {
          args.push('--min-speakers', options.minSpeakers.toString());
        }
        if (options.maxSpeakers !== undefined) {
          args.push('--max-speakers', options.maxSpeakers.toString());
        }
      }

      if (options.hfToken) {
        args.push('--hf-token', options.hfToken);
      }

      const startTime = Date.now();
      console.log('[pyannote-worker] Diarization command', {
        pythonExe: this.pythonExecutable,
        args: [this.scriptPath, ...args],
        cwd: this.pluginDir,
        audioPath: options.audioPath,
        expectedSpeakers: options.expectedSpeakers,
      });

      const worker = spawn(this.pythonExecutable, [this.scriptPath, ...args], {
        signal: options.signal,
        env: {
          ...process.env,
          PYTHONUNBUFFERED: '1',
          PYTHONIOENCODING: 'utf-8',
          PYTHONPATH: [
            this.pluginDir,
            process.env.PYTHONPATH ?? '',
          ].filter(Boolean).join(path.delimiter),
        },
        cwd: this.pluginDir,
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe'],
      });

      console.log("[local-transcriber] Diarisation worker started", { pid: worker.pid });

      let stdout = '';
      let stderr = '';
      let lastOutputTime = Date.now();

      const stallTimeoutMs = 60000;
      const stallCheckInterval = setInterval(() => {
        if (Date.now() - lastOutputTime > stallTimeoutMs) {
          console.warn("[local-transcriber] Diarisation worker produced no output", {
            elapsedMs: Date.now() - startTime,
            stallTimeoutMs,
          });
          worker.kill('SIGKILL');
          clearInterval(stallCheckInterval);
          reject(new Error('Diarisation worker stalled (no output for 60s).'));
        }
      }, 10000);

      const onAbort = () => {
        console.log("[local-transcriber] Cancelling worker", { kind: "pyannote", pid: worker.pid });
        worker.kill('SIGTERM');
        setTimeout(() => {
            if (!worker.killed) {
                console.warn("[local-transcriber] Worker did not exit gracefully, forcing kill", { kind: "pyannote", pid: worker.pid });
                worker.kill('SIGKILL');
            }
        }, 2000);
      };

      if (options.signal) {
          if (options.signal.aborted) {
              onAbort();
          } else {
              options.signal.addEventListener('abort', onAbort);
          }
      }

      worker.stdout.on('data', (data) => {
        stdout += data.toString();
        console.log(`[local-transcriber-diarization] STDOUT: ${data.toString().trim()}`);
        lastOutputTime = Date.now();
      });

      worker.stderr.on('data', (data) => {
        stderr += data.toString();
        console.warn(`[local-transcriber-diarization] STDERR: ${data.toString().trim()}`);
        lastOutputTime = Date.now();
      });

      worker.on('exit', (code, signal) => {
        console.log('[pyannote-worker] Diarization worker exited', { code, signal });
      });

      worker.on('close', (code) => {
        clearInterval(stallCheckInterval);

        if (options.signal) {
            options.signal.removeEventListener('abort', onAbort);
        }

        if (options.signal?.aborted) {
            console.log("[local-transcriber] Worker terminated", { kind: "pyannote", reason: "cancelled" });
            reject(new Error("Cancelled"));
            return;
        }

        if (code !== 0) {
          console.error("[local-transcriber] Diarisation failed", {
            exitCode: code,
            signal: options.signal?.aborted ? 'aborted' : undefined,
            stderr,
          });
          reject(new Error(`Diarisation worker failed with code ${code}`));
          return;
        }

        try {
          const jsonStr = stdout.trim();
          // Find the last line that looks like JSON, which is our result payload
          const lines = jsonStr.split('\n');
          let parsed: any;
          for (let i = lines.length - 1; i >= 0; i--) {
              try {
                  const line = lines[i];
                  if (!line) continue;
                  parsed = JSON.parse(line);
                  if (parsed.segments) {
                      break;
                  }
              } catch (e) {
                  // ignore
              }
          }
          if (!parsed || !parsed.segments) {
              throw new Error("Could not find valid segments in output");
          }
          resolve(parsed.segments as DiarizationSegment[]);
        } catch (err: any) {
          console.error("[local-transcriber] Diarisation output parse failed", { stdout, error: err.message });
          reject(new Error(`Failed to parse diarisation output: ${err.message}`));
        }
      });

      worker.on('error', (err) => {
        clearInterval(stallCheckInterval);
        reject(err);
      });
    });
  }
}
