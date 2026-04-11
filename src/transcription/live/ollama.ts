import { App } from 'obsidian';
import * as path from 'path';
import { spawn } from 'child_process';
import { LiveTranscriptionBackend, LiveTranscriptionOptions, TranscriptionEvent, Segment } from '../events';
import LocalTranscriberPlugin from '../../main';

export class OllamaLiveBackend implements LiveTranscriptionBackend {
    constructor(private plugin: LocalTranscriberPlugin) {}

    async transcribeChunk(options: LiveTranscriptionOptions, onEvent: (event: TranscriptionEvent) => void): Promise<{ segments: Segment[] }> {
        return new Promise((resolve, reject) => {
            onEvent({ type: 'meta', backend: 'ollama', model: options.modelId });

            reject(new Error(`Audio transcription is not natively supported by the standard Ollama API yet. Sending audio to '${options.modelId}' directly causes it to hallucinate. Please select a Python Whisper model.`));
        });
    }
}
