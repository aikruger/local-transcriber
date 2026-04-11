import { requestUrl } from 'obsidian';

export class OllamaEnvironment {

	async isOllamaRunning(): Promise<boolean> {
		try {
			const res = await requestUrl({
				url: 'http://localhost:11434/',
				method: 'GET'
			});
			return res.status === 200;
		} catch (e) {
			return false;
		}
	}

	async getOllamaModels(): Promise<{ name: string, modified_at: string, size: number, digest: string }[]> {
		try {
			const res = await requestUrl({
				url: 'http://localhost:11434/api/tags',
				method: 'GET'
			});
			if (res.status === 200) {
				return res.json.models || [];
			}
			return [];
		} catch (e) {
			console.error('Failed to list Ollama models:', e);
			return [];
		}
	}
}
