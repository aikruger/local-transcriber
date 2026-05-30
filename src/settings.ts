import { App, PluginSettingTab, Setting, Notice } from "obsidian";
import LocalTranscriberPlugin from "./main";

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

	// backendFilter ONLY scopes the file model dropdown, never live
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
	liveChunkSeconds: 5,          // 5 s default — good balance on CPU
	liveChunkOverlapSeconds: 0.5,
	liveAutoCreateNote: true,
	liveOutputFolder: "Live_Transcripts/",
	liveKeepRawAudio: true,
	liveDiarizationMode: "finalize",
	liveMicDeviceId: "default",
	liveSilenceGateDb: -40,
	liveModelSize: "faster-whisper::tiny",  // tiny default = fast cold start
	liveLanguage: "en",
	backendFilter: "faster-whisper",
};

function addSectionHeader(el: HTMLElement, title: string, subtitle?: string) {
	const wrapper = el.createDiv({ cls: "lt-section-header" });
	wrapper.createEl("h3", { text: title });
	if (subtitle) wrapper.createEl("p", { text: subtitle, cls: "lt-section-desc" });
}

export class LocalTranscriberSettingTab extends PluginSettingTab {
	plugin: LocalTranscriberPlugin;

	constructor(app: App, plugin: LocalTranscriberPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();

		const allModels = this.plugin.modelRegistry.getAllModels();

		// File models — filtered by backendFilter
		const fileModels = allModels.filter(
			(m) =>
				m.modeSupport.includes("file") &&
				(this.plugin.settings.backendFilter === "all" ||
					m.backend === this.plugin.settings.backendFilter)
		);

		// Live models — NEVER filtered, so the dropdown is never empty
		const liveModels = allModels.filter((m) => m.modeSupport.includes("live"));

		// ── 1. FILE TRANSCRIPTION ───────────────────────────────────────────
		addSectionHeader(
			containerEl,
			"📄 File Transcription",
			"Settings used when transcribing an existing audio or video file from your vault."
		);

		new Setting(containerEl)
			.setName("File transcription backend")
			.setDesc(
				"Filter the model list below to a specific backend. " +
				"Faster Whisper is recommended — it is 4–8× faster than the legacy Python Whisper backend."
			)
			.addDropdown((dropdown) =>
				dropdown
					.addOption("all", "All backends")
					.addOption("faster-whisper", "Faster Whisper (recommended)")
					.addOption("python-whisper", "Python Whisper (legacy)")
					.addOption("ollama", "Ollama")
					.setValue(this.plugin.settings.backendFilter)
					.onChange(
						async (value: "all" | "python-whisper" | "ollama" | "faster-whisper") => {
							this.plugin.settings.backendFilter = value;
							await this.plugin.saveSettings();
							this.display();
						}
					)
			);

		if (fileModels.length === 0) {
			containerEl.createEl("p", {
				text: "⚠️  No models found for the selected backend. Try refreshing Ollama models below, or switch to a different backend.",
				cls: "lt-warning",
			});
		} else {
			new Setting(containerEl)
				.setName("File model")
				.setDesc("The model used when transcribing a file. Larger models are more accurate but slower.")
				.addDropdown((dropdown) => {
					fileModels.forEach((m) => dropdown.addOption(`${m.backend}::${m.id}`, m.label));

					if (
						!fileModels.find(
							(m) => `${m.backend}::${m.id}` === this.plugin.settings.modelSize
						) && fileModels.length > 0
					) {
						const first = fileModels[0]!;
						this.plugin.settings.modelSize = `${first.backend}::${first.id}`;
					}

					dropdown.setValue(this.plugin.settings.modelSize);
					dropdown.onChange(async (value) => {
						this.plugin.settings.modelSize = value;
						await this.plugin.saveSettings();
					});
				});
		}

		new Setting(containerEl)
			.setName("File transcription language")
			.setDesc(
				'Language code for file transcription. Use "en" for English. ' +
				'Use "auto" only when the language is unknown — it adds processing time.'
			)
			.addText((text) =>
				text
					.setPlaceholder("en")
					.setValue(this.plugin.settings.fileLanguage)
					.onChange(async (value) => {
						this.plugin.settings.fileLanguage = value || "en";
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("Speaker diarization (default)")
			.setDesc(
				"Number of speakers for diarization. Set to None to disable. " +
				"Diarization requires Pyannote and significantly increases processing time."
			)
			.addDropdown((dropdown) =>
				dropdown
					.addOption("0", "None (no diarization)")
					.addOption("auto", "Auto-detect")
					.addOption("2", "2 speakers")
					.addOption("3", "3 speakers")
					.addOption("4", "4 speakers")
					.addOption("6", "6 speakers")
					.setValue(this.plugin.settings.speakers)
					.onChange(async (value) => {
						this.plugin.settings.speakers = value;
						await this.plugin.saveSettings();
					})
			);

		// ── 2. LIVE TRANSCRIPTION ───────────────────────────────────────────
		addSectionHeader(
			containerEl,
			"🎙 Live Transcription",
			"Settings used when recording from your microphone in real time. " +
			"These are independent of the file transcription settings above."
		);

		if (liveModels.length === 0) {
			containerEl.createEl("p", {
				text: "⚠️  No live-capable models found. Install Faster Whisper or refresh Ollama models in the Environment section below.",
				cls: "lt-warning",
			});
		} else {
			new Setting(containerEl)
				.setName("Live model")
				.setDesc(
					"Model used during live dictation. For lowest latency use tiny or tiny.en. " +
					"base or base.en gives the best speed/quality balance on most laptops. " +
					"This is independent of the file model above."
				)
				.addDropdown((dropdown) => {
					liveModels.forEach((m) => dropdown.addOption(`${m.backend}::${m.id}`, m.label));

					if (
						!liveModels.find(
							(m) => `${m.backend}::${m.id}` === this.plugin.settings.liveModelSize
						) && liveModels.length > 0
					) {
						const first = liveModels[0]!;
						this.plugin.settings.liveModelSize = `${first.backend}::${first.id}`;
					}

					dropdown.setValue(this.plugin.settings.liveModelSize);
					dropdown.onChange(async (value) => {
						this.plugin.settings.liveModelSize = value;
						await this.plugin.saveSettings();
					});
				});
		}

		new Setting(containerEl)
			.setName("Live transcription language")
			.setDesc('Language code for live dictation. Use "en" for English.')
			.addText((text) =>
				text
					.setPlaceholder("en")
					.setValue(this.plugin.settings.liveLanguage)
					.onChange(async (value) => {
						this.plugin.settings.liveLanguage = value || "en";
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("Chunk length (seconds)")
			.setDesc(
				"How many seconds of audio are collected before being sent to the model. " +
				"Shorter = lower latency but more fragmentation. " +
				"Recommended: 5 s (base model), 3 s (tiny model). Minimum: 2 s."
			)
			.addDropdown((dropdown) =>
				dropdown
					.addOption("2", "2 s — lowest latency (tiny only)")
					.addOption("3", "3 s — low latency")
					.addOption("5", "5 s — balanced (recommended)")
					.addOption("8", "8 s — smoother sentences")
					.addOption("10", "10 s — best context, highest latency")
					.setValue(String(this.plugin.settings.liveChunkSeconds))
					.onChange(async (value) => {
						this.plugin.settings.liveChunkSeconds = parseInt(value, 10);
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("Chunk overlap (seconds)")
			.setDesc(
				"Amount of audio shared between consecutive chunks to avoid cutting words at boundaries. " +
				"Default: 0.5 s. Increase to 1 s if words are being cut off."
			)
			.addDropdown((dropdown) =>
				dropdown
					.addOption("0", "0 s — no overlap")
					.addOption("0.5", "0.5 s (recommended)")
					.addOption("1", "1 s")
					.addOption("1.5", "1.5 s")
					.setValue(String(this.plugin.settings.liveChunkOverlapSeconds))
					.onChange(async (value) => {
						this.plugin.settings.liveChunkOverlapSeconds = parseFloat(value);
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("Silence gate threshold (dB)")
			.setDesc(
				"Chunks quieter than this level are skipped — the model is not called. " +
				"Default: −40 dB. Raise to −30 dB in a noisy environment."
			)
			.addDropdown((dropdown) =>
				dropdown
					.addOption("-50", "−50 dB — very sensitive")
					.addOption("-40", "−40 dB (recommended)")
					.addOption("-35", "−35 dB")
					.addOption("-30", "−30 dB — less sensitive")
					.addOption("-25", "−25 dB — noisy environment")
					.setValue(String(this.plugin.settings.liveSilenceGateDb))
					.onChange(async (value) => {
						this.plugin.settings.liveSilenceGateDb = parseFloat(value);
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("Live speaker diarization")
			.setDesc(
				"Off — no speaker labels. " +
				"Finalize — single diarization pass over the full session when you stop (most accurate). " +
				"Live — label each chunk individually (fast but speaker IDs may drift)."
			)
			.addDropdown((dropdown) =>
				dropdown
					.addOption("off", "Off — no speakers")
					.addOption("finalize", "Finalize — post-session pass (recommended)")
					.addOption("live", "Live — per-chunk (may drift)")
					.setValue(this.plugin.settings.liveDiarizationMode)
					.onChange(async (value: "off" | "live" | "finalize") => {
						this.plugin.settings.liveDiarizationMode = value;
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("Ollama text cleanup (Stage 2)")
			.setDesc(
				"After transcribing each chunk, send the raw text to a local Ollama model to fix punctuation, " +
				"remove filler words, and correct mis-transcriptions. " +
				"Requires Ollama running locally. Falls back silently to raw text if unavailable."
			)
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.liveOllamaCleanupEnabled)
					.onChange(async (value) => {
						this.plugin.settings.liveOllamaCleanupEnabled = value;
						await this.plugin.saveSettings();
						this.display();
					})
			);

		if (this.plugin.settings.liveOllamaCleanupEnabled) {
			const ollamaModels = allModels.filter((m) => m.backend === "ollama");

			new Setting(containerEl)
				.setName("Ollama cleanup model")
				.setDesc(
					"Local Ollama model used for text cleanup. " +
					"Recommended: llama3.2 or mistral for speed; llama3.1:8b for quality."
				)
				.addDropdown((dropdown) => {
					dropdown.addOption("", "— select model —");
					ollamaModels.forEach((m) => dropdown.addOption(m.id, m.label));
					dropdown.setValue(this.plugin.settings.liveOllamaCleanupModel);
					dropdown.onChange(async (value) => {
						this.plugin.settings.liveOllamaCleanupModel = value;
						await this.plugin.saveSettings();
					});
				});
		}

		new Setting(containerEl)
			.setName("Live output folder")
			.setDesc("Vault folder where live transcripts and audio chunks are saved.")
			.addText((text) =>
				text
					.setPlaceholder("Live_Transcripts/")
					.setValue(this.plugin.settings.liveOutputFolder)
					.onChange(async (value) => {
						this.plugin.settings.liveOutputFolder = value || "Live_Transcripts/";
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("Save raw session audio")
			.setDesc(
				"Keep the full session WAV file after recording ends. " +
				"Useful for reprocessing with a better model later."
			)
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.liveKeepRawAudio)
					.onChange(async (value) => {
						this.plugin.settings.liveKeepRawAudio = value;
						await this.plugin.saveSettings();
					})
			);

		// ── 3. OUTPUT ───────────────────────────────────────────────────────
		addSectionHeader(
			containerEl,
			"💾 Output",
			"Controls the format and location of saved transcription files."
		);

		new Setting(containerEl)
			.setName("Output format")
			.setDesc("File format(s) written after a file transcription completes.")
			.addDropdown((dropdown) =>
				dropdown
					.addOption("SRT", "SRT subtitle file")
					.addOption("TXT", "Plain text with timestamps")
					.addOption("Both", "SRT + TXT")
					.addOption("MD", "Markdown only (no SRT/TXT files)")
					.setValue(this.plugin.settings.outputFormat)
					.onChange(async (value) => {
						this.plugin.settings.outputFormat = value;
						await this.plugin.saveSettings();
						this.display();
					})
			);

		new Setting(containerEl)
			.setName("Output folder")
			.setDesc("Vault folder where SRT / TXT / MD files are saved.")
			.addText((text) =>
				text
					.setPlaceholder("Audio/")
					.setValue(this.plugin.settings.audioFolder)
					.onChange(async (value) => {
						this.plugin.settings.audioFolder = value || "Audio/";
						await this.plugin.saveSettings();
					})
			);

		if (this.plugin.settings.outputFormat !== "MD") {
			new Setting(containerEl)
				.setName("Create Markdown note")
				.setDesc(
					"Automatically create a Markdown note with the transcript embedded alongside the audio file."
				)
				.addToggle((toggle) =>
					toggle
						.setValue(this.plugin.settings.createMarkdownNote)
						.onChange(async (value) => {
							this.plugin.settings.createMarkdownNote = value;
							await this.plugin.saveSettings();
						})
				);
		}

		new Setting(containerEl)
			.setName("Markdown paragraph interval")
			.setDesc(
				"Group transcript into paragraphs by time window. " +
				"Breaks also occur at natural speech pauses."
			)
			.addDropdown((dropdown) =>
				dropdown
					.addOption("0", "None — one line per segment")
					.addOption("1", "1 minute")
					.addOption("2", "2 minutes")
					.addOption("5", "5 minutes")
					.addOption("10", "10 minutes")
					.setValue(String(this.plugin.settings.markdownInterval))
					.onChange(async (value) => {
						this.plugin.settings.markdownInterval = parseInt(value, 10);
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("Natural pause threshold (seconds)")
			.setDesc(
				"A gap between transcript segments longer than this triggers a paragraph break. Default: 1.5 s."
			)
			.addText((text) =>
				text
					.setPlaceholder("1.5")
					.setValue(String(this.plugin.settings.markdownPauseGap))
					.onChange(async (value) => {
						this.plugin.settings.markdownPauseGap = parseFloat(value) || 1.5;
						await this.plugin.saveSettings();
					})
			);

		// ── 4. ENVIRONMENT & MODELS ─────────────────────────────────────────
		addSectionHeader(
			containerEl,
			"⚙️ Environment & Models",
			"Configure the local Python environment, model storage, and installed model lists. " +
			"You do not normally need to change these after initial setup."
		);

		new Setting(containerEl)
			.setName("Refresh Ollama model list")
			.setDesc(
				"Query the local Ollama instance and update the list of available models. " +
				"Run this after installing a new model with 'ollama pull'."
			)
			.addButton((btn) =>
				btn.setButtonText("Refresh Ollama models").onClick(async () => {
					await this.plugin.modelDiscovery.refreshAll(
						this.plugin.settings.availableModels
					);
					new Notice("Ollama model list refreshed.");
					this.display();
				})
			);

		new Setting(containerEl)
			.setName("Python Whisper model list")
			.setDesc(
				"Only relevant if you are using the legacy Python Whisper backend. " +
				"Enter one model name per line (e.g. tiny, base, small, medium, large-v3). " +
				"These names must match official Whisper identifiers and appear in the File Model dropdown " +
				"when the Python Whisper backend is selected."
			)
			.addTextArea((text) =>
				text
					.setPlaceholder("tiny\nbase\nsmall")
					.setValue(this.plugin.settings.availableModels)
					.onChange(async (value) => {
						this.plugin.settings.availableModels = value;
						await this.plugin.saveSettings();
						await this.plugin.modelDiscovery.refreshAll(
							this.plugin.settings.availableModels
						);
						this.display();
					})
			);

		new Setting(containerEl)
			.setName("Models folder")
			.setDesc(
				"Absolute path to a folder where Whisper / Faster Whisper model files are stored. " +
				"Leave blank to use the plugin's built-in models/ folder."
			)
			.addText((text) =>
				text
					.setPlaceholder("/path/to/models or C:\\models")
					.setValue(this.plugin.settings.modelsFolder)
					.onChange(async (value) => {
						this.plugin.settings.modelsFolder = value.trim();
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("Python executable path")
			.setDesc(
				"Path to the Python 3 executable. Required on macOS and Linux if Python is not on the system PATH. " +
				"Leave blank on Windows — the plugin will locate Python automatically."
			)
			.addText((text) =>
				text
					.setPlaceholder("/usr/local/bin/python3")
					.setValue(this.plugin.settings.pythonPath || "")
					.onChange(async (value) => {
						this.plugin.settings.pythonPath = value || null;
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("Auto-install dependencies on Windows")
			.setDesc(
				"Attempt to install Python and FFmpeg automatically via winget if they are missing. " +
				"Disable if you manage your own Python environment."
			)
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.installOnWindows)
					.onChange(async (value) => {
						this.plugin.settings.installOnWindows = value;
						await this.plugin.saveSettings();
					})
			);
	}
}
