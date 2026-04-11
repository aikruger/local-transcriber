import { App, Notice } from 'obsidian';
import LocalTranscriberPlugin from './main';

export class Diagnostics {
	plugin: LocalTranscriberPlugin;
	app: App;

	constructor(plugin: LocalTranscriberPlugin) {
		this.plugin = plugin;
		this.app = plugin.app;
	}

	async runDiagnostics() {
		new Notice('Running diagnostics...');
		try {
			// Python Diagnostics
			const pyPath = this.plugin.pythonEnv.getPythonExecutable();

			const checkScript = `
import sys
try:
	import whisper
	import pyannote.audio
	import soundfile
	import numpy
	print('OK')
except Exception as e:
	print(f'Error: {e}')
	sys.exit(1)
			`;

			const { exec } = require('child_process');
			const fs = require('fs');
			const util = require('util');
			const execPromise = util.promisify(exec);

			try {
				const result = await execPromise(`"${pyPath}" -c "${checkScript.replace(/\n/g, '; ')}"`);
				if (result.stdout.trim() === 'OK') {
					new Notice('✅ Python imports OK (whisper, pyannote, soundfile, numpy)');
				} else {
					new Notice('❌ Python imports failed');
				}
			} catch (e: any) {
				new Notice(`❌ Python check failed: ${e.message}`);
			}

			// FFmpeg
			const hasFf = await this.plugin.pythonEnv.hasFFmpeg();
			if (hasFf) {
				new Notice('✅ FFmpeg OK');
			} else {
				new Notice('❌ FFmpeg not found');
			}

			// Microphone
			const hasMic = await navigator.mediaDevices.getUserMedia({ audio: true }).then(() => true).catch(() => false);
			if (hasMic) {
				new Notice('✅ Microphone access OK');
			} else {
				new Notice('❌ Microphone access denied or unavailable');
			}

			// Writable path
			const folderPath = this.plugin.settings.liveOutputFolder;
			const adapter = this.app.vault.adapter as any;
			if (!await adapter.exists(folderPath.replace(/\/$/, ''))) {
				await this.app.vault.createFolder(folderPath.replace(/\/$/, ''));
			}
			new Notice('✅ Write permissions to output folder OK');

			// Ollama Diagnostics
			const ollamaRunning = await this.plugin.ollamaEnv.isOllamaRunning();
			if (ollamaRunning) {
				new Notice('✅ Ollama is running');
				const models = await this.plugin.ollamaEnv.getOllamaModels();
				if (models.length > 0) {
					new Notice(`✅ Ollama models found (${models.length})`);
				} else {
					new Notice('⚠️ Ollama is running but no models found');
				}
			} else {
				new Notice('❌ Ollama is not reachable on localhost:11434');
			}

		} catch (e: any) {
			new Notice(`❌ Diagnostics failed: ${e.message}`);
		}
	}
}
