export interface TranscriptWord {
  text: string;
  start: number; // seconds
  end: number;   // seconds
  probability?: number;
  confidence?: number;
}

export interface TranscriptSegment {
  start: number;
  end: number;
  text: string;
  words?: TranscriptWord[];
  language?: string;
  speaker?: string;        // e.g. "SPEAKER_00" or mapped name
  speakerConfidence?: number;
}

export interface DiarizationSegment {
  start: number;
  end: number;
  speaker: string;         // e.g. "SPEAKER_00"
  confidence?: number;
}

export interface TranscriptResult {
  sourcePath: string;
  language?: string;
  duration?: number;
  segments: TranscriptSegment[];
  diarization?: DiarizationSegment[];
  speakerMap?: Record<string, string>; // SPEAKER_00 -> "Interviewer"
}
