import { TranscriptionModelDescriptor, ModelRegistry } from './registry';
import { OllamaEnvironment } from '../environment/ollama';

export class ModelDiscovery {

    static BUILTIN_WHISPER_MODELS = [
        "tiny.en", "tiny", "base.en", "base", "small.en", "small", "medium.en", "medium", "large-v1", "large-v2", "large-v3"
    ];

    constructor(
        private registry: ModelRegistry,
        private ollamaEnv: OllamaEnvironment
    ) {}

    async discoverBuiltinWhisper() {
        for (const id of ModelDiscovery.BUILTIN_WHISPER_MODELS) {
            this.registry.register({
                id: id,
                label: `${id} (Python Whisper)`,
                backend: "python-whisper",
                modeSupport: ["file", "live"],
                installed: true, // We assume it's downloaded on demand by python
                source: "builtin"
            });
        }
    }

    async discoverCustomWhisper(customModels: string) {
        const models = customModels.split('\n').map(m => m.trim()).filter(m => m.length > 0);
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
