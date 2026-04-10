import { App } from 'obsidian';
import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs';
import { execFile, spawn } from 'child_process';
import LocalTranscriberPlugin from './main';

export class Environment {
	plugin: LocalTranscriberPlugin;
	app: App;

	constructor(plugin: LocalTranscriberPlugin) {
		this.plugin = plugin;
		this.app = plugin.app;
	}

	async setupWhisperEnvironment(logger: { log: (msg: string) => void, setStage: (stage: string) => void }) {
		let hasPy = await this.hasPython();
		let hasFf = await this.hasFFmpeg();

		if (!hasPy && this.plugin.settings.installOnWindows && os.platform() === 'win32') {
			logger.log('Python not found. Installing Python (this may take several minutes)...');
			await this.installPythonWindows();
			hasPy = await this.hasPython();
		}

		if (!hasFf && this.plugin.settings.installOnWindows && os.platform() === 'win32') {
			logger.log('FFmpeg not found. Installing FFmpeg...');
			await this.installFFmpegWindows();
			hasFf = await this.hasFFmpeg();
		}

		if (!hasPy) {
			throw new Error("Python is required. Please install Python 3.10+ and add it to PATH.");
		}
		if (!hasFf) {
			throw new Error("FFmpeg is required. Please install FFmpeg and add it to PATH.");
		}

		this.plugin.settings.envReady = true;
		await this.plugin.saveSettings();

		if (!this.plugin.settings.modelsReady) {
			logger.setStage('Bootstrapping models');
			logger.log('Downloading models (~500MB)...');
			await this.bootstrapPython(logger);
			this.plugin.settings.modelsReady = true;
			await this.plugin.saveSettings();
		}
	}

	getModelsDir(): string {
		if (this.plugin.settings.modelsFolder && this.plugin.settings.modelsFolder.trim() !== '') {
			return this.plugin.settings.modelsFolder.trim();
		}
		const adapter: any = this.app.vault.adapter;
		const base = adapter?.getBasePath ? adapter.getBasePath() : '';
		return path.join(base, this.app.vault.configDir, 'plugins', 'local-transcriber', 'models');
	}

	getPythonExecutable(): string {
		return this.plugin.settings.pythonPath || (os.platform() === 'win32' ? 'python' : 'python3');
	}

	async hasPython(): Promise<boolean> {
		return new Promise((resolve) => {
			execFile(this.getPythonExecutable(), ['--version'], (error) => {
				if (error) {
					if (os.platform() !== 'win32' && !this.plugin.settings.pythonPath) {
						execFile('python3', ['--version'], (err2) => {
							resolve(!err2);
						});
					} else {
						resolve(false);
					}
				} else {
					resolve(true);
				}
			});
		});
	}

	async hasFFmpeg(): Promise<boolean> {
		return new Promise((resolve) => {
			execFile('ffmpeg', ['-version'], (error) => resolve(!error));
		});
	}

	async installPythonWindows(): Promise<void> {
		return new Promise((resolve, reject) => {
			execFile('winget', ['install', 'Python.Python.3.12', '--accept-package-agreements', '--accept-source-agreements'], (error, stdout, stderr) => {
				if (error) reject(new Error(`Failed to install Python: ${stderr || error.message}`));
				else resolve();
			});
		});
	}

	async installFFmpegWindows(): Promise<void> {
		return new Promise((resolve, reject) => {
			execFile('winget', ['install', 'FFmpeg (Essentials Build)', '--accept-package-agreements', '--accept-source-agreements'], (error, stdout, stderr) => {
				if (error) reject(new Error(`Failed to install FFmpeg: ${stderr || error.message}`));
				else resolve();
			});
		});
	}

	async bootstrapPython(logger: { log: (msg: string) => void }): Promise<void> {
		return new Promise((resolve, reject) => {
			const adapter: any = this.app.vault.adapter;
			const vaultPath = adapter && adapter.getBasePath ? adapter.getBasePath() : '';
			const pluginDir = path.join(vaultPath, this.app.vault.configDir, 'plugins', 'local-transcriber');
			const bootstrapScript = path.join(pluginDir, 'local_transcriber', 'bootstrap.py');
			const modelsDir = this.getModelsDir();

			if (!fs.existsSync(bootstrapScript)) {
				reject(new Error(
					`bootstrap.py not found at: ${bootstrapScript}\n` +
					`Ensure the local_transcriber/ folder is inside the plugin directory.`
				));
				return;
			}

			if (!fs.existsSync(modelsDir)) {
				fs.mkdirSync(modelsDir, { recursive: true });
			}

			const pyPath = this.getPythonExecutable();
			const child = spawn(pyPath, [bootstrapScript, '--models-dir', modelsDir]);

			let stderrOutput = '';
			child.stderr.on('data', (data) => {
				stderrOutput += data.toString();
				const lines = data.toString().split('\n').filter((l: string) => l.trim());
				for (const line of lines) {
					logger.log(`[stderr] ${line}`);
				}
			});

			child.stdout.on('data', (data) => {
				const lines = data.toString().split('\n').filter((l: string) => l.trim());
				for (const line of lines) {
					try {
						const msg = JSON.parse(line);
						if (msg.status === 'installing') logger.log(`Installing: ${msg.package}...`);
						else if (msg.status === 'downloading_model') logger.log(`Downloading model: ${msg.model}...`);
						else if (msg.status === 'done') logger.log('Bootstrap complete.');
					} catch (e) {
						logger.log(line);
					}
				}
			});

			child.on('close', (code) => {
				if (code === 0) resolve();
				else {
					reject(new Error(
						`Bootstrap failed with code ${code}.\n` +
						(stderrOutput ? `Python error:\n${stderrOutput}` : 'No stderr output captured.')
					));
				}
			});
		});
	}
}
