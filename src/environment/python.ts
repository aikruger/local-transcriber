import { App } from 'obsidian';
import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs';
import { execFile, spawn } from 'child_process';
import LocalTranscriberPlugin from '../main';

export class PythonEnvironment {
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

		logger.setStage('Installing dependencies and models...');
		await this.bootstrapPython(logger);

		this.plugin.settings.envReady = true;
		this.plugin.settings.modelsReady = true;
		await this.plugin.saveSettings();
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
		const stored = this.plugin.settings.pythonPath;
		// Guard: reject venv paths that are not the plugin's own environment
		// The hermes-agent venv is a known bad path to watch for
		if (stored && stored.trim() !== '') {
			const lowerPath = stored.toLowerCase();
			// If the stored path looks like an external agent/tool venv, ignore it
			const isSuspiciousVenv = lowerPath.includes('hermes') ||
									  lowerPath.includes('copilot') ||
									  lowerPath.includes('agent') && lowerPath.includes('venv');
			if (isSuspiciousVenv) {
				console.warn(`[PythonEnvironment] getPythonExecutable() — stored path looks like an external venv, ignoring: "${stored}"`);
				// Clear the bad path
				this.plugin.settings.pythonPath = '';
				// Don't await here — fire and forget
				this.plugin.saveSettings().catch(e => console.error('[PythonEnvironment] Failed to clear bad pythonPath:', e));
			} else {
				console.log(`[PythonEnvironment] getPythonExecutable() → "${stored}"`);
				return stored;
			}
		}
		const fallback = os.platform() === 'win32' ? 'python' : 'python3';
		console.log(`[PythonEnvironment] getPythonExecutable() → "${fallback}" (fallback)`);
		return fallback;
	}

	async resolvePythonExecutable(): Promise<string> {
		const current = this.getPythonExecutable();
		// If already absolute, return as-is
		if (path.isAbsolute(current)) {
			console.log(`[PythonEnvironment] resolvePythonExecutable() — already absolute: "${current}"`);
			return current;
		}
		// Resolve 'python' or 'python3' to an absolute path
		const whichCmd = os.platform() === 'win32' ? 'where' : 'which';
		return new Promise((resolve) => {
			execFile(whichCmd, [current], (error, stdout) => {
				if (error || !stdout.trim()) {
					console.warn(`[PythonEnvironment] Could not resolve "${current}" via ${whichCmd}, using as-is`);
					resolve(current);
				} else {
					// 'where' on Windows returns multiple lines; take the first non-empty one
					// Skip Microsoft Store stubs (WindowsApps)
					const lines = stdout.trim().split(/\r?\n/)
						.map(l => l.trim())
						.filter(l => l.length > 0 && !l.toLowerCase().includes('windowsapps'));
					const resolved = lines[0] || current;
					console.log(`[PythonEnvironment] resolvePythonExecutable() "${current}" → "${resolved}"`);
					resolve(resolved);
				}
			});
		});
	}

	async verifyFasterWhisper(): Promise<boolean> {
		return new Promise((resolve) => {
			const pyPath = this.getPythonExecutable();
			console.log(`[PythonEnvironment] verifyFasterWhisper() — testing import with: ${pyPath}`);
			execFile(pyPath, ['-c', 'import faster_whisper; print("ok")'], (error, stdout, stderr) => {
				if (error || !stdout.trim().startsWith('ok')) {
					console.error(`[PythonEnvironment] faster_whisper import FAILED. stderr: ${stderr}`);
					resolve(false);
				} else {
					console.log(`[PythonEnvironment] faster_whisper import verified OK`);
					resolve(true);
				}
			});
		});
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
		// Resolve the absolute Python path BEFORE spawning bootstrap
		const pyPath = await this.resolvePythonExecutable();
		console.log(`[PythonEnvironment] bootstrapPython() — using Python: "${pyPath}"`);
		// Save it immediately so all future calls use the same interpreter
		this.plugin.settings.pythonPath = pyPath;
		await this.plugin.saveSettings();

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

			const child = spawn(pyPath, [bootstrapScript, '--models-dir', modelsDir]);

			let stderrOutput = '';
			child.stderr.on('data', (data) => {
				stderrOutput += data.toString();
				const lines = data.toString().split('\n').filter((l: string) => l.trim());
				for (const line of lines) {
					logger.log(`[stderr] ${line}`);
				}
			});

			child.stdout.on('data', async (data) => {
				const lines = data.toString().split('\n').filter((l: string) => l.trim());
				for (const line of lines) {
					try {
						const msg = JSON.parse(line);
						if (msg.status === 'installing') logger.log(`Installing: ${msg.package}...`);
						else if (msg.status === 'downloading_model') logger.log(`Downloading model: ${msg.model}...`);
						else if (msg.status === 'done') {
							logger.log('Bootstrap complete.');
							// Persist the exact Python executable that ran bootstrap
							if (msg.python_executable) {
								console.log(`[PythonEnvironment] Bootstrap confirmed Python path: ${msg.python_executable}`);
								this.plugin.settings.pythonPath = msg.python_executable;
								await this.plugin.saveSettings();
								logger.log(`Using Python: ${msg.python_executable}`);
							}
						}
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
