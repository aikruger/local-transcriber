import { App, PluginSettingTab, Setting, Notice } from "obsidian";
import LocalTranscriberPlugin from "./main";
import * as path from 'path';
import * as fs from 'fs';

export interface LocalTranscriberSettings {
	envReady: boolean;
	modelsReady: boolean;
	pythonPath: string | null;
	installOnWindows: boolean;
	modelSize: string;
	modelsFolder: string;
	availableModels: string;
	fileLanguage: string;
	liveLanguage: string;
	speakers: string;
	outputFormat: string;
	audioFolder: string;
	createMarkdownNote: boolean;
	markdownInterval: number;
	markdownPauseGap: number;
	liveChunkSeconds: number;
	liveChunkOverlapSeconds: number;
	liveAutoCreateNote: boolean;
	liveOutputFolder: string;
	liveKeepRawAudio: boolean;
	liveDiarizationMode: "off" | "live" | "finalize";
	liveMicDeviceId: string;
	liveSilenceGateDb: number;
	liveModelSize: string;
	liveOllamaCleanupModel: string;
	liveOllamaCleanupEnabled: boolean;
	backendFilter: "all" | "python-whisper" | "ollama" | "faster-whisper";
}

export const DEFAULT_SETTINGS: LocalTranscriberSettings = {
	envReady: false,
	modelsReady: false,
	pythonPath: null,
	installOnWindows: true,
	modelSize: "faster-whisper::base",
	modelsFolder: "",
	availableModels: "tiny\nbase\nsmall",
	liveOllamaCleanupModel: "",
	liveOllamaCleanupEnabled: false,
	fileLanguage: "en",
	speakers: "0",
	outputFormat: "SRT",
	audioFolder: "Audio/",
	createMarkdownNote: true,
	markdownInterval: 5,
	markdownPauseGap: 1.5,
	liveChunkSeconds: 5,
	liveChunkOverlapSeconds: 0.5,
	liveAutoCreateNote: true,
	liveOutputFolder: "Live_Transcripts/",
	liveKeepRawAudio: true,
	liveDiarizationMode: "finalize",
	liveMicDeviceId: "default",
	liveSilenceGateDb: -40,
	liveModelSize: "faster-whisper::tiny",
	liveLanguage: "en",
	backendFilter: "faster-whisper",
};

export class LocalTranscriberSettingTab extends PluginSettingTab {
	plugin: LocalTranscriberPlugin;

	constructor(app: App, plugin: LocalTranscriberPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	async handleModelDownload(modelId: string, button: any) {
		button.setDisabled(true);
		button.setButtonText("Downloading...");
		new Notice("Downloading " + modelId + "... check console.");
		try {
			await this.plugin.pythonEnv.downloadModel(modelId, {
				log: (msg: string) => console.log("[Download] " + msg)
			});
			new Notice(modelId + " downloaded successfully!");
		} catch (e: any) {
			new Notice("Download failed: " + e.message);
		} finally {
			button.setDisabled(false);
			button.setButtonText("Download Selected");
			this.display();
		}
	}

	private isModelInstalled(modelId: string, modelsDir: string): boolean {
		console.log(`[Settings] isModelInstalled — scanning modelsDir="${modelsDir}" for modelId="${modelId}"`);

		if (!fs.existsSync(modelsDir)) {
			console.warn(`[Settings] modelsDir does not exist: "${modelsDir}"`);
			return false;
		}

		let topLevel: string[];
		try {
			topLevel = fs.readdirSync(modelsDir);
			console.log(`[Settings] Top-level entries:`, topLevel);
		} catch (e) {
			console.error(`[Settings] Failed to read modelsDir:`, e);
			return false;
		}

		const modelIdLower = modelId.toLowerCase();

		for (const entry of topLevel) {
			const entryLower = entry.toLowerCase();

			// Check if top-level entry name contains the modelId
			if (entryLower.includes(modelIdLower)) {
				console.log(`[Settings] ✅ Top-level match: "${entry}" contains "${modelId}"`);
				return true;
			}

			// Scan one level deeper for nested structures (e.g. HuggingFace snapshots)
			const subPath = path.join(modelsDir, entry);
			try {
				const stat = fs.statSync(subPath);
				if (stat.isDirectory()) {
					const subEntries = fs.readdirSync(subPath);
					for (const sub of subEntries) {
						if (sub.toLowerCase().includes(modelIdLower)) {
							console.log(`[Settings] ✅ Deep match: "${entry}/${sub}" contains "${modelId}"`);
							return true;
						}
					}
				}
			} catch (subErr) {
				console.warn(`[Settings] Could not read subdir "${subPath}":`, subErr);
			}
		}

		console.log(`[Settings] ❌ No match found for modelId="${modelId}"`);
		return false;
	}

	private renderModelSetting(
		containerEl: HTMLElement,
		name: string,
		models: any[],
		currentVal: string,
		setter: (val: string) => Promise<void>
	) {
		let selected = currentVal;
		const s = new Setting(containerEl).setName(name);

		// ✅ Use descEl — sits below the setting name, never competes with
		// controlEl's flex row that holds the dropdown and button
		const statusEl = s.descEl;
		statusEl.style.fontStyle = "normal";

		const updateStatus = (val: string) => {
			const parts = val.split('::');
			const modelId = parts[1];

			console.log(`[Settings] updateStatus — val="${val}", modelId="${modelId}"`);

			if (!modelId) {
				statusEl.setText("Status: Unknown");
				statusEl.style.color = "var(--text-muted)";
				statusEl.style.fontWeight = "normal";
				return;
			}

			const modelsDir = this.plugin.pythonEnv.getModelsDir();
			const isInstalled = this.isModelInstalled(modelId, modelsDir);

			statusEl.setText(isInstalled ? "✅ Installed" : "⬇ Not installed");
			statusEl.style.fontWeight = isInstalled ? "bold" : "normal";
			statusEl.style.color = isInstalled
				? "var(--text-accent)"
				: "var(--text-muted)";
		};

		s.addDropdown(d => {
			if (models.length === 0) {
				console.warn(`[Settings] No models available for "${name}" dropdown`);
				d.addOption("", "No models available");
			}
			models.forEach(m => {
				const optVal = m.backend + "::" + m.id;
				console.log(`[Settings] Adding option: ${optVal} → ${m.label}`);
				d.addOption(optVal, m.label);
			});
			d.setValue(selected);
			d.onChange(val => {
				console.log(`[Settings] "${name}" dropdown changed to: ${val}`);
				selected = val;
				updateStatus(val);
			});
		});

		s.addButton(b =>
			b.setButtonText("Download Selected").onClick(async () => {
				const modelId = selected.split('::')[1];
				console.log(`[Settings] Download clicked — modelId="${modelId}"`);
				if (modelId) {
					await this.handleModelDownload(modelId, b);
					await setter(selected);
					updateStatus(selected);
				}
			})
		);

		// Called after addDropdown so the resolved dropdown value is confirmed
		updateStatus(selected);
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();

		console.log("[Settings] display() called — rebuilding settings UI");

		const allModels = this.plugin.modelRegistry.getAllModels();
		console.log(`[Settings] Total models from registry: ${allModels.length}`);

		const fileModels = allModels.filter(m =>
			m.modeSupport.includes("file") &&
			(this.plugin.settings.backendFilter === "all" ||
				m.backend === this.plugin.settings.backendFilter)
		);
		const liveModels = allModels.filter(m => m.modeSupport.includes("live"));

		console.log(`[Settings] fileModels: ${fileModels.length}, liveModels: ${liveModels.length}`);

		containerEl.createEl("h2", { text: "Local Transcriber Settings" });

		// ── Environment ──────────────────────────────────────────────────────
		containerEl.createEl("h3", { text: "⚙️ Environment" });

		new Setting(containerEl)
			.setName("Reset environment")
			.setDesc("Re-runs the Python/Whisper environment setup.")
			.addButton(b =>
				b.setButtonText("Reset").onClick(async () => {
					console.log("[Settings] Reset environment clicked");
					this.plugin.settings.modelsReady = false;
					await this.plugin.pythonEnv.setupWhisperEnvironment({
						log: console.log,
						setStage: (s) => new Notice(s)
					});
					this.display();
				})
			);

		new Setting(containerEl)
			.setName("Backend filter")
			.setDesc("Filter which backends appear in the File Model dropdown.")
			.addDropdown(d => {
				d.addOption("all", "All");
				d.addOption("faster-whisper", "Faster Whisper");
				d.addOption("python-whisper", "Python Whisper");
				d.addOption("ollama", "Ollama");
				d.setValue(this.plugin.settings.backendFilter);
				d.onChange(async val => {
					console.log(`[Settings] Backend filter changed to: ${val}`);
					this.plugin.settings.backendFilter = val as LocalTranscriberSettings["backendFilter"];
					await this.plugin.saveSettings();
					this.display();
				});
			});

		// ── Model Selection ───────────────────────────────────────────────────
		containerEl.createEl("h3", { text: "🤖 Model Selection" });

		this.renderModelSetting(
			containerEl,
			"File Model",
			fileModels,
			this.plugin.settings.modelSize,
			async (v) => {
				this.plugin.settings.modelSize = v;
				await this.plugin.saveSettings();
			}
		);

		this.renderModelSetting(
			containerEl,
			"Live Model",
			liveModels,
			this.plugin.settings.liveModelSize,
			async (v) => {
				this.plugin.settings.liveModelSize = v;
				await this.plugin.saveSettings();
			}
		);

		// ── File Transcription ────────────────────────────────────────────────
		containerEl.createEl("h3", { text: "📄 File Transcription" });

		new Setting(containerEl)
			.setName("File transcription language")
			.setDesc("BCP-47 language code, e.g. 'en', 'fr', 'de'.")
			.addText(t =>
				t.setValue(this.plugin.settings.fileLanguage)
					.onChange(async v => {
						this.plugin.settings.fileLanguage = v;
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("Speaker diarization (File)")
			.setDesc("Set to 0 for auto-detect, or enter a specific number of speakers.")
			.addText(t =>
				t.setValue(this.plugin.settings.speakers)
					.onChange(async v => {
						this.plugin.settings.speakers = v;
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("Output format")
			.setDesc("Format for the transcription output file.")
			.addDropdown(d => {
				["SRT", "VTT", "TXT", "JSON"].forEach(fmt => d.addOption(fmt, fmt));
				d.setValue(this.plugin.settings.outputFormat);
				d.onChange(async v => {
					this.plugin.settings.outputFormat = v;
					await this.plugin.saveSettings();
				});
			});

		new Setting(containerEl)
			.setName("Audio folder")
			.setDesc("Vault-relative folder to watch for audio files.")
			.addText(t =>
				t.setValue(this.plugin.settings.audioFolder)
					.onChange(async v => {
						this.plugin.settings.audioFolder = v;
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("Create Markdown note")
			.setDesc("Automatically create a Markdown note alongside the transcription.")
			.addToggle(t =>
				t.setValue(this.plugin.settings.createMarkdownNote)
					.onChange(async v => {
						this.plugin.settings.createMarkdownNote = v;
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("Markdown interval (seconds)")
			.setDesc("How often to write progress to the Markdown note during transcription.")
			.addText(t =>
				t.setValue(String(this.plugin.settings.markdownInterval))
					.onChange(async v => {
						const n = parseFloat(v);
						if (!isNaN(n)) {
							this.plugin.settings.markdownInterval = n;
							await this.plugin.saveSettings();
						}
					})
			);

		new Setting(containerEl)
			.setName("Markdown pause gap (seconds)")
			.setDesc("Minimum silence gap before starting a new paragraph in the Markdown note.")
			.addText(t =>
				t.setValue(String(this.plugin.settings.markdownPauseGap))
					.onChange(async v => {
						const n = parseFloat(v);
						if (!isNaN(n)) {
							this.plugin.settings.markdownPauseGap = n;
							await this.plugin.saveSettings();
						}
					})
			);

		// ── Live Transcription ────────────────────────────────────────────────
		containerEl.createEl("h3", { text: "🎙 Live Transcription" });

		new Setting(containerEl)
			.setName("Live transcription language")
			.setDesc("BCP-47 language code, e.g. 'en', 'fr', 'de'.")
			.addText(t =>
				t.setValue(this.plugin.settings.liveLanguage)
					.onChange(async v => {
						this.plugin.settings.liveLanguage = v;
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("Live chunk length (seconds)")
			.setDesc("How many seconds of audio to buffer before sending for transcription.")
			.addText(t =>
				t.setValue(String(this.plugin.settings.liveChunkSeconds))
					.onChange(async v => {
						const n = parseFloat(v);
						if (!isNaN(n)) {
							this.plugin.settings.liveChunkSeconds = n;
							await this.plugin.saveSettings();
						}
					})
			);

		new Setting(containerEl)
			.setName("Live chunk overlap (seconds)")
			.setDesc("Overlap between consecutive audio chunks to avoid missed words at boundaries.")
			.addText(t =>
				t.setValue(String(this.plugin.settings.liveChunkOverlapSeconds))
					.onChange(async v => {
						const n = parseFloat(v);
						if (!isNaN(n)) {
							this.plugin.settings.liveChunkOverlapSeconds = n;
							await this.plugin.saveSettings();
						}
					})
			);

		new Setting(containerEl)
			.setName("Auto-create note on live start")
			.setDesc("Automatically create a new Markdown note when live transcription begins.")
			.addToggle(t =>
				t.setValue(this.plugin.settings.liveAutoCreateNote)
					.onChange(async v => {
						this.plugin.settings.liveAutoCreateNote = v;
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("Live output folder")
			.setDesc("Vault-relative folder where live transcription notes are saved.")
			.addText(t =>
				t.setValue(this.plugin.settings.liveOutputFolder)
					.onChange(async v => {
						this.plugin.settings.liveOutputFolder = v;
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("Keep raw audio chunks")
			.setDesc("Retain the temporary WAV chunk files after a live session ends.")
			.addToggle(t =>
				t.setValue(this.plugin.settings.liveKeepRawAudio)
					.onChange(async v => {
						this.plugin.settings.liveKeepRawAudio = v;
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("Silence gate (dB)")
			.setDesc("Audio below this level (e.g. -40) is treated as silence and skipped.")
			.addText(t =>
				t.setValue(String(this.plugin.settings.liveSilenceGateDb))
					.onChange(async v => {
						const n = parseFloat(v);
						if (!isNaN(n)) {
							this.plugin.settings.liveSilenceGateDb = n;
							await this.plugin.saveSettings();
						}
					})
			);

		new Setting(containerEl)
			.setName("Diarization mode")
			.setDesc("When to run speaker diarization during live transcription.")
			.addDropdown(d => {
				d.addOption("off", "Off");
				d.addOption("live", "Live (experimental)");
				d.addOption("finalize", "Finalize (after session ends)");
				d.setValue(this.plugin.settings.liveDiarizationMode);
				d.onChange(async val => {
					this.plugin.settings.liveDiarizationMode = val as LocalTranscriberSettings["liveDiarizationMode"];
					await this.plugin.saveSettings();
				});
			});

		// ── Ollama Cleanup ────────────────────────────────────────────────────
		containerEl.createEl("h3", { text: "🦙 Ollama Cleanup" });

		new Setting(containerEl)
			.setName("Enable Ollama cleanup")
			.setDesc("Use an Ollama model to clean up live transcription output after each session.")
			.addToggle(t =>
				t.setValue(this.plugin.settings.liveOllamaCleanupEnabled)
					.onChange(async v => {
						console.log(`[Settings] Ollama cleanup toggled: ${v}`);
						this.plugin.settings.liveOllamaCleanupEnabled = v;
						await this.plugin.saveSettings();
						this.display();
					})
			);

		if (this.plugin.settings.liveOllamaCleanupEnabled) {
			new Setting(containerEl)
				.setName("Ollama cleanup model")
				.setDesc("The Ollama model name to use for cleanup (e.g. 'llama3', 'mistral').")
				.addText(t =>
					t.setValue(this.plugin.settings.liveOllamaCleanupModel)
						.setPlaceholder("e.g. llama3")
						.onChange(async v => {
							this.plugin.settings.liveOllamaCleanupModel = v;
							await this.plugin.saveSettings();
						})
				);
		}
	}
}