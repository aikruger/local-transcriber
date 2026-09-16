import { spawn } from 'child_process';
import * as path from 'path';
import { DiarizationOptions, DiarizationBackend } from './types';
import { DiarizationSegment } from '../models/transcript';

export class PyannoteWorker implements DiarizationBackend {
  private pythonExecutable: string;
  private scriptPath: string;

  constructor(pythonExecutable: string, pluginDir: string) {
    this.pythonExecutable = pythonExecutable;
    this.scriptPath = path.join(pluginDir, 'scripts', 'diarize.py');
  }

  async diarize(options: DiarizationOptions): Promise<DiarizationSegment[]> {
    console.log("[local-transcriber] Starting diarisation", {
      audioPath: options.audioPath,
      expectedSpeakers: options.expectedSpeakers,
      backend: "pyannote",
    });

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
      const worker = spawn(this.pythonExecutable, [this.scriptPath, ...args], { signal: options.signal });

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
        lastOutputTime = Date.now();
      });

      worker.stderr.on('data', (data) => {
        stderr += data.toString();
        console.log(`[local-transcriber-diarization] STDERR: ${data.toString().trim()}`);
        lastOutputTime = Date.now();
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
          const parsed = JSON.parse(jsonStr);
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
