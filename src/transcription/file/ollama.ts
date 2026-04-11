import { App } from 'obsidian';
import * as path from 'path';
import * as fs from 'fs';
import { spawn } from 'child_process';
import { FileTranscriptionBackend, FileTranscriptionOptions, TranscriptionEvent, Segment } from '../events';
import LocalTranscriberPlugin from '../../main';

export class OllamaFileBackend implements FileTranscriptionBackend {
    constructor(private plugin: LocalTranscriberPlugin) {}

    async transcribeFile(options: FileTranscriptionOptions, onEvent: (event: TranscriptionEvent) => void): Promise<{ segments: Segment[] }> {
        return new Promise(async (resolve, reject) => {
            onEvent({ type: 'meta', backend: 'ollama', model: options.modelId });

            // Since Ollama does not natively support an audio upload endpoint,
            // the user will experience hallucinated texts (like "I don't see an image")
            // if we blindly pass base64 audio to the images array of the generate API.
            // Until Ollama officially adds /api/audio or multimodal audio input, we cannot
            // transcribe via pure Ollama.
            // However, some custom API proxies or forks might accept it.
            // To prevent a confusing UX, we throw a clear error.

            reject(new Error(`Audio transcription is not natively supported by the standard Ollama API yet. Sending audio to '${options.modelId}' directly causes it to hallucinate. Please select a Python Whisper model.`));
        });
    }
}
