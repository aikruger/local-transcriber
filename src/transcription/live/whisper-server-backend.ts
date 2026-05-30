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

    const pythonPath = this.plugin.pythonEnv.getPythonExecutable();
    const scriptPath = this.resolveServerScript();
    const modelsDir  = this.plugin.pythonEnv.getModelsDir();

    const args = [
      scriptPath,
      "--model",       modelId,
      "--language",    language || "en",
      "--compute-type","int8",
      "--device",      "cpu",
    ];
    if (modelsDir) args.push("--models-dir", modelsDir);

    return new Promise((resolve, reject) => {
      const proc = child_process.spawn(pythonPath, args, {
        stdio: ["pipe", "pipe", "pipe"],
      });

      this.process = proc;

      // Line-by-line reader on stdout
      this.rl = readline.createInterface({ input: proc.stdout! });

      this.rl.on("line", (line) => this.handleLine(line));

      proc.stderr!.on("data", (chunk) => {
        // Python stack traces come here — log but don't crash
        console.error("[whisper-server stderr]", chunk.toString());
      });

      proc.on("exit", (code) => {
        this.isReady = false;
        if (this.currentReject) {
          this.currentReject(new Error(`Server exited with code ${code}`));
          this.currentReject = null;
          this.currentResolve = null;
        }
      });

      // Wait for first "ready" message
      const onFirstReady = (line: string) => {
        try {
          const msg = JSON.parse(line);
          if (msg.type === "ready") {
            this.isReady = true;
            this.rl!.off("line", onFirstReady);
            resolve();
          } else if (msg.type === "error") {
            reject(new Error(msg.error));
          }
        } catch (_) {}
      };
      this.rl.on("line", onFirstReady);

      // Safety timeout — if no ready in 60 s, something went wrong
      setTimeout(() => {
        if (!this.isReady) {
          reject(new Error("Whisper server timed out waiting for ready signal"));
          this.shutdown();
        }
      }, 60_000);
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

    try {
      if (this.process.stdin && !this.process.stdin.destroyed) {
        this.process.stdin.write(JSON.stringify({ type: "shutdown" }) + "\n");
      }
    } catch (_) {}

    return new Promise((resolve) => {
      const timeout = setTimeout(() => {
        this.process?.kill("SIGKILL");
        resolve();
      }, 5000);

      this.process!.on("exit", () => {
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
