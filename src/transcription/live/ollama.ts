import { LiveTranscriptionBackend, LiveTranscriptionOptions, TranscriptionEvent, Segment } from '../events';
import LocalTranscriberPlugin from '../../main';

const OLLAMA_BASE_URL = 'http://localhost:11434';

const CLEANUP_PROMPT = (raw: string) =>
`You are a transcription editor. Clean up the following raw speech-to-text output.
Fix punctuation, remove filler words (um, uh, er, like), fix obvious mis-transcriptions,
and make it read naturally. Output only the cleaned text, nothing else. No explanations.

Raw transcript:
${raw}

Cleaned transcript:`;

export class OllamaLiveBackend implements LiveTranscriptionBackend {
    constructor(private plugin: LocalTranscriberPlugin) {}

    async transcribeChunk(
        options: LiveTranscriptionOptions,
        onEvent: (event: TranscriptionEvent) => void
    ): Promise<{ segments: Segment[] }> {
        // Stage 2 only: requires raw segments from stage 1 (faster-whisper)
        const rawSegments: Segment[] = (options as any).rawSegments ?? [];

        if (rawSegments.length === 0) {
            return { segments: [] };
        }

        const modelId = options.modelId; // e.g. "llama3.2:latest"

        const cleanedSegments: Segment[] = [];

        for (const seg of rawSegments) {
            try {
                const response = await fetch(`${OLLAMA_BASE_URL}/api/generate`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        model: modelId,
                        prompt: CLEANUP_PROMPT(seg.text),
                        stream: false,
                        options: {
                            temperature: 0.1,  // low temp = consistent, deterministic cleanup
                            num_predict: 200
                        }
                    }),
                    signal: AbortSignal.timeout(8000) // 8s max per segment — don't stall live session
                });

                if (!response.ok) {
                    // Ollama unavailable — fall back to raw text silently
                    cleanedSegments.push(seg);
                    continue;
                }

                const data = await response.json();
                const cleaned = (data.response ?? '').trim();

                if (cleaned) {
                    const cleanedSeg: Segment = {
                        ...seg,
                        text: cleaned
                    };
                    onEvent({ ...cleanedSeg, type: 'segment', backend: 'ollama-cleanup' });
                    cleanedSegments.push(cleanedSeg);
                } else {
                    cleanedSegments.push(seg); // fallback to raw if Ollama returns empty
                }
            } catch {
                // Timeout, network error, or Ollama not running — use raw text
                cleanedSegments.push(seg);
            }
        }

        return { segments: cleanedSegments };
    }
}
