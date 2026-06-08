import * as child_process from "child_process";
import * as readline from "readline";
import * as path from "path";
import LocalTranscriberPlugin from "../../main";

export interface ChunkRequest {
  chunkPath: string;
  chunkStart: number;
  sessionId: string;
}

export interface TranscribeResult {
  segments: Array<{
    start: number;
    end: number;
    text: string;
    speaker: string | null;
  }>;
}

type EventCallback = (event: any) => void;

export class WhisperServerBackend {
  private plugin: LocalTranscriberPlugin;
  private process: child_process.ChildProcess | null = null;
  private rl: readline.Interface | null = null;
  private isReady: boolean = false;
  private currentResolve: ((result: TranscribeResult) => void) | null = null;
  private currentReject: ((err: Error) => void) | null = null;
  private currentSegments: TranscribeResult["segments"] = [];
  private currentOnEvent: EventCallback = () => {};

  constructor(plugin: LocalTranscriberPlugin) {
    this.plugin = plugin;
  }

  /**
   * Start the server process and wait for {"type":"ready"}.
   * Call once at session start. Takes 10–25 s on first load (model download/cache).
   */
  async start(modelId: string, language: string): Promise<void> {
    if (this.isReady) return;

    // Pre-flight check: confirm faster_whisper is importable by this Python
    const isFwAvailable = await this.plugin.pythonEnv.verifyFasterWhisper();
    if (!isFwAvailable) {
        const pyPath = this.plugin.pythonEnv.getPythonExecutable();
        console.error(`[WhisperServer] faster_whisper not found in Python at: ${pyPath}`);
        throw new Error(
            `Model load failed: No module named 'faster_whisper'.\n` +
            `The Python executable "${pyPath}" does not have faster_whisper installed.\n` +
            `Please run Setup again from the plugin settings, or manually run:\n` +
            `"${pyPath}" -m pip install faster-whisper`
        );
    }
    console.log(`[WhisperServer] Pre-flight passed — faster_whisper available`);

    const pythonPath = this.plugin.pythonEnv.getPythonExecutable();
    const scriptPath = this.resolveServerScript();
    const modelsDir  = this.plugin.pythonEnv.getModelsDir();

    const args = [
        scriptPath,
        "--model",        modelId,
        "--language",     language || "en",
        "--compute-type", "int8",
        "--device",       "cpu",
    ];
    if (modelsDir) args.push("--models-dir", modelsDir);

    console.log(`[WhisperServer] Spawning: "${pythonPath}" ${args.join(' ')}`);

    return new Promise((resolve, reject) => {
        // *** CRITICAL: track whether startup has settled ***
        let startupSettled = false;

        const proc = child_process.spawn(pythonPath, args, {
            stdio: ["pipe", "pipe", "pipe"],
        });

        this.process = proc;
        this.rl = readline.createInterface({ input: proc.stdout! });
        this.rl.on("line", (line) => this.handleLine(line));

        proc.stderr!.on("data", (chunk) => {
            const msg = chunk.toString();
            console.error(`[WhisperServer] Python stderr: ${msg}`);
            // Reject startup immediately on import errors
            if (!startupSettled && msg.includes("No module named")) {
                startupSettled = true;
                reject(new Error(`Model load failed: ${msg.trim()}`));
            }
        });

        // *** FIX: exit handler now rejects the STARTUP promise if not yet settled ***
        proc.on("exit", (code, signal) => {
            console.log(`[WhisperServer] Process exited — code=${code}, signal=${signal}, startupSettled=${startupSettled}, isReady=${this.isReady}`);
            this.isReady = false;
            if (!startupSettled) {
                // Process died before emitting "ready" — reject the startup promise
                startupSettled = true;
                reject(new Error(`Whisper server process exited (code=${code}, signal=${signal}) before becoming ready. Check Python stderr above for details.`));
            } else if (this.currentReject) {
                // Process died during an active transcription request
                this.currentReject(new Error(`Server exited with code ${code}`));
                this.currentReject = null;
                this.currentResolve = null;
            }
        });

        // Wait for first "ready" message
        const onFirstReady = (line: string) => {
            try {
                const msg = JSON.parse(line);
                console.log(`[WhisperServer] Startup message received: ${JSON.stringify(msg)}`);
                if (msg.type === "ready") {
                    startupSettled = true;
                    this.isReady = true;
                    this.rl!.off("line", onFirstReady);
                    console.log(`[WhisperServer] Server is ready — model loaded`);
                    resolve();
                } else if (msg.type === "error") {
                    if (!startupSettled) {
                        startupSettled = true;
                        reject(new Error(msg.error));
                    }
                }
            } catch (_) {}
        };
        this.rl.on("line", onFirstReady);

        // Safety timeout
        const startupTimeout = setTimeout(() => {
            if (!startupSettled) {
                startupSettled = true;
                console.error(`[WhisperServer] Startup timed out after 60s`);
                reject(new Error("Whisper server timed out waiting for ready signal"));
                this.shutdown();
            }
        }, 60_000);

        // Clear timeout if process exits before it fires
        proc.on("exit", () => clearTimeout(startupTimeout));
    });
  }

  /**
   * Transcribe a single chunk. Resolves when the "result" message is received.
   */
  transcribeChunk(req: ChunkRequest, onEvent: EventCallback): Promise<TranscribeResult> {
    if (!this.isReady || !this.process || !this.process.stdin) {
      return Promise.reject(new Error("Whisper server is not running"));
    }

    return new Promise((resolve, reject) => {
      this.currentResolve   = resolve;
      this.currentReject    = reject;
      this.currentSegments  = [];
      this.currentOnEvent   = onEvent;

      const request = JSON.stringify({
        type:       "transcribe",
        chunkPath:  req.chunkPath,
        chunkStart: req.chunkStart,
        sessionId:  req.sessionId,
      });

      this.process!.stdin!.write(request + "\n");
    });
  }

  /** Send shutdown and wait for the process to exit. */
    async shutdown(): Promise<void> {
    if (!this.process) return;

    console.log("[WhisperServer] Sending shutdown signal...");
    try {
      if (this.process.stdin && !this.process.stdin.destroyed) {
        this.process.stdin.write(JSON.stringify({ type: "shutdown" }) + "\n");
      }
    } catch (_) {}

    return new Promise((resolve) => {
      const timeout = setTimeout(() => {
        console.warn("[WhisperServer] Shutdown timed out, killing process.");
        this.process?.kill("SIGKILL");
        resolve();
      }, 5000);

      this.process!.on("exit", (code) => {
        console.log(`[WhisperServer] Process exited with code ${code}`);
        clearTimeout(timeout);
        this.process = null;
        this.rl = null;
        this.isReady = false;
        resolve();
      });
    });
  }

  get ready(): boolean {
    return this.isReady;
  }

  // ── private helpers ──────────────────────────────────────────────────────

  private handleLine(line: string) {
    let msg: any;
    try {
      msg = JSON.parse(line);
    } catch (_) {
      return; // ignore non-JSON lines (Python warnings, etc.)
    }

    this.currentOnEvent(msg);

    switch (msg.type) {
      case "segment":
        this.currentSegments.push({
          start:   msg.start,
          end:     msg.end,
          text:    msg.text,
          speaker: msg.speaker ?? null,
        });
        break;

      case "result":
        if (this.currentResolve) {
          this.currentResolve({ segments: this.currentSegments });
          this.currentResolve = null;
          this.currentReject  = null;
          this.currentSegments = [];
        }
        break;

      case "error":
        if (this.currentReject) {
          this.currentReject(new Error(msg.error ?? "Unknown error from server"));
          this.currentReject  = null;
          this.currentResolve = null;
          this.currentSegments = [];
        }
        break;
    }
  }

  private resolveServerScript(): string {
    // Find whisper_server.py relative to the plugin's Python package directory
    const adapter = this.plugin.app.vault.adapter as any;
    const basePath = adapter.getBasePath ? adapter.getBasePath() : "";
    return path.join(
      basePath,
      this.plugin.app.vault.configDir,
      "plugins",
      "local-transcriber",
      "local_transcriber",
      "whisper_server.py"
    );
  }
}
