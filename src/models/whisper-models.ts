export interface WhisperModelInfo {
  id: string; // e.g. "tiny", "base", "small", "medium", "large-v3"
  label: string; // user-facing name
  paramsM: number; // millions of parameters
  relativeSpeed: number; // relative to large-v3 = 1.0
  recommendedFor: string; // short description
}

export const WHISPER_MODELS: WhisperModelInfo[] = [
  {
    id: "tiny",
    label: "Tiny (fastest, least accurate)",
    paramsM: 39,
    relativeSpeed: 12,
    recommendedFor: "Quick drafts, very clear audio",
  },
  {
    id: "base",
    label: "Base (fast)",
    paramsM: 74,
    relativeSpeed: 8,
    recommendedFor: "Short recordings, clear speech",
  },
  {
    id: "small",
    label: "Small (balanced)",
    paramsM: 244,
    relativeSpeed: 4,
    recommendedFor: "General use, moderate quality",
  },
  {
    id: "medium",
    label: "Medium (high quality)",
    paramsM: 769,
    relativeSpeed: 2,
    recommendedFor: "Important interviews, noisy audio",
  },
  {
    id: "large-v3",
    label: "Large-v3 (best quality, slowest)",
    paramsM: 1550,
    relativeSpeed: 1,
    recommendedFor: "Final transcripts, domain terms",
  },
];

export function estimateTranscriptionTime(
  durationSeconds: number,
  modelId: string
): { minSeconds: number; maxSeconds: number } {
  const model = WHISPER_MODELS.find((m) => m.id === modelId);
  if (!model) throw new Error(`Unknown Whisper model: ${modelId}`);

  // Base assumption: large-v3 ~= 1x real-time on average hardware.
  // Adjust by relativeSpeed.
  const baseFactor = 1 / model.relativeSpeed;

  // Add variance for hardware and audio complexity.
  const minFactor = baseFactor * 0.7;
  const maxFactor = baseFactor * 1.5;

  return {
    minSeconds: Math.round(durationSeconds * minFactor),
    maxSeconds: Math.round(durationSeconds * maxFactor),
  };
}
