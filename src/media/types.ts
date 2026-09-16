export interface MediaInfo {
  path: string;
  duration?: number;
  hasAudio: boolean;
  hasVideo: boolean;
  audioCodec?: string;
  videoCodec?: string;
}

export interface PrepareAudioOptions {
  inputPath: string;
  outputDir?: string;
  sampleRate?: number; // default 16000
  channels?: number;   // default 1
  signal?: AbortSignal;
}

export interface PreparedAudio {
  wavPath: string;
  duration?: number;
  cleanup: () => Promise<void>;
}
