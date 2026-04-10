export interface TranscriptionModelDescriptor {
  id: string;              // e.g. "base.en" or "karanchopda333/whisper"
  label: string;           // user-facing name
  backend: "python-whisper" | "ollama";
  modeSupport: ("file" | "live")[];
  languageSupport?: string[];
  installed: boolean;
  source: "builtin" | "local-folder" | "ollama" | "custom-whisper";
}

export class ModelRegistry {
    private models: Map<string, TranscriptionModelDescriptor> = new Map();

    register(model: TranscriptionModelDescriptor) {
        // Unique ID could be combination of backend + id to handle overlap?
        // Let's assume id is unique across backends or we prefix them internally if needed.
        // Actually, "base.en" (python) vs "base.en" (ollama - though ollama usually has repo/name)
        const key = `${model.backend}::${model.id}`;
        this.models.set(key, model);
    }

    clearOllamaModels() {
        for (const [key, model] of this.models.entries()) {
            if (model.backend === "ollama") {
                this.models.delete(key);
            }
        }
    }

    getAllModels(): TranscriptionModelDescriptor[] {
        return Array.from(this.models.values());
    }

    getModelsByMode(mode: "file" | "live"): TranscriptionModelDescriptor[] {
        return this.getAllModels().filter(m => m.modeSupport.includes(mode));
    }

    getModel(backend: "python-whisper" | "ollama", id: string): TranscriptionModelDescriptor | undefined {
        return this.models.get(`${backend}::${id}`);
    }

    clear() {
        this.models.clear();
    }
}
