export interface Segment {
    start: number;
    end: number;
    text: string;
    speaker?: string | null;
}

export type TranscriptionEvent =
  | { type: "meta"; duration?: number; language?: string; model?: string; backend: string; chunkStart?: number }
  | { type: "partial"; text: string; chunk?: string; backend: string }
  | { type: "segment"; start: number; end: number; text: string; speaker?: string | null; backend: string }
  | { type: "progress"; phase: string; recordedSeconds?: number; transcribedSeconds?: number; remainingSeconds?: number }
  | { type: "result"; segments: Segment[]; backend: string; meta?: any }
  | { type: "error"; error: string; backend: string };

export interface FileTranscriptionOptions {
    inputPath: string;
    modelId: string;
    language: string;
    speakers: string; // "0", "auto", "2", etc.
    modelsDir?: string;
}

export interface LiveTranscriptionOptions {
    chunkPath: string;
    chunkStart: number;
    sessionId: string;
    modelId: string;
    language: string;
    modelsDir?: string;
}

export interface FileTranscriptionBackend {
    transcribeFile(options: FileTranscriptionOptions, onEvent: (event: TranscriptionEvent) => void): Promise<{ segments: Segment[] }>;
}

export interface LiveTranscriptionBackend {
    transcribeChunk(options: LiveTranscriptionOptions, onEvent: (event: TranscriptionEvent) => void): Promise<{ segments: Segment[] }>;
}
