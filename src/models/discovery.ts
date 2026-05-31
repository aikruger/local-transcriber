import { TranscriptionModelDescriptor, ModelRegistry } from './registry';
import { OllamaEnvironment } from '../environment/ollama';
import * as fs from 'fs';
import * as path from 'path';

export class ModelDiscovery {

    static BUILTIN_WHISPER_MODELS = [
        "tiny", "base", "small", "medium", "large-v1", "large-v2", "large-v3"
    ];

    constructor(
        private registry: ModelRegistry,
        private ollamaEnv: OllamaEnvironment
    ) {}

    async discoverBuiltinWhisper() {
        for (const id of ModelDiscovery.BUILTIN_WHISPER_MODELS) {
            this.registry.register({
                id: id,
                label: `${id} (Faster Whisper)`,
                backend: "faster-whisper",
                modeSupport: ["file", "live"],
                installed: true,
                source: "builtin"
            });
        }
    }

    async discoverCustomWhisper(customModels: string) {
        const models = customModels.split('\n').map(m => m.trim()).filter(m => m.length > 0);

        // Auto-scan local models dir
        const mDir = (window as any).localTranscriberModelsDir;
        if (fs.existsSync(mDir)) {
            const dirs = fs.readdirSync(mDir);
            for (const d of dirs) {
                if (d.startsWith("models--")) {
                    const modelName = d.replace("models--", "").replace(/--/g, "/");
                    if (!models.includes(modelName)) models.push(modelName);
                }
            }
        }

        for (const id of models) {
            // Only add if not already a builtin
            if (!ModelDiscovery.BUILTIN_WHISPER_MODELS.includes(id)) {
                this.registry.register({
                    id: id,
                    label: `${id} (Custom Whisper)`,
                    backend: "python-whisper",
                    modeSupport: ["file", "live"],
                    installed: true,
                    source: "custom-whisper"
                });
            }
        }
    }

    async discoverOllamaModels() {
        this.registry.clearOllamaModels();
        const models = await this.ollamaEnv.getOllamaModels();
        for (const m of models) {
            this.registry.register({
                id: m.name,
                label: `${m.name} (Ollama)`,
                backend: "ollama",
                modeSupport: ["file", "live"],
                installed: true,
                source: "ollama"
            });
        }
    }

    async refreshAll(customModelsList: string) {
        this.registry.clear();
        await this.discoverBuiltinWhisper();
        await this.discoverCustomWhisper(customModelsList);
        await this.discoverOllamaModels();
    }
}
