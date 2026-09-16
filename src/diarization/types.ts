import { DiarizationSegment } from '../models/transcript';

export interface DiarizationOptions {
  audioPath: string;
  minSpeakers?: number;
  maxSpeakers?: number;
  expectedSpeakers?: number;
  hfToken?: string;
  signal?: AbortSignal;
}

export interface DiarizationBackend {
  diarize(options: DiarizationOptions): Promise<DiarizationSegment[]>;
}
