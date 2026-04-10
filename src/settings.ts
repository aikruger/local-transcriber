import { App, PluginSettingTab, Setting, Notice } from "obsidian";
import LocalTranscriberPlugin from "./main";

export interface LocalTranscriberSettings {
	envReady: boolean;
	modelsReady: boolean;
	pythonPath: string | null;
	installOnWindows: boolean;
	modelSize: string; // The selected File model ID
	modelsFolder: string;
	availableModels: string;

	// Split language for file vs live
	fileLanguage: string;
	liveLanguage: string;

	speakers: string;
	outputFormat: string;
	audioFolder: string;
	createMarkdownNote: boolean;
	markdownInterval: number;
	markdownPauseGap: number;

	// Live Transcription Settings
	liveChunkSeconds: number;
	liveChunkOverlapSeconds: number;
	liveAutoCreateNote: boolean;
	liveOutputFolder: string;
	liveKeepRawAudio: boolean;
	liveDiarizationMode: "off" | "live" | "finalize";
	liveMicDeviceId: string;
	liveSilenceGateDb: number;
	liveModelSize: string; // The selected Live model ID

	backendFilter: "all" | "python-whisper" | "ollama";
}

export const DEFAULT_SETTINGS: LocalTranscriberSettings = {
	envReady: false,
	modelsReady: false,
	pythonPath: null,
	installOnWindows: true,
	modelSize: "python-whisper::base.en",
	modelsFolder: "",
	availableModels: "tiny.en\nbase.en\nsmall.en",
	fileLanguage: "en",
	speakers: "0",
	outputFormat: "SRT",
	audioFolder: "Audio/",
	createMarkdownNote: true,
	markdownInterval: 5,
	markdownPauseGap: 1.5,

	// Live Transcription Settings defaults
	liveChunkSeconds: 3,
	liveChunkOverlapSeconds: 0.75,
	liveAutoCreateNote: true,
	liveOutputFolder: "Live_Transcripts/",
	liveKeepRawAudio: true,
	liveDiarizationMode: "finalize",
	liveMicDeviceId: "default",
	liveSilenceGateDb: -40,
	liveModelSize: "python-whisper::tiny.en",
	liveLanguage: "en",

	backendFilter: "all"
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

		containerEl.createEl('h3', { text: 'Transcription' });

		const filteredModels = this.plugin.modelRegistry.getAllModels().filter(m =>
			this.plugin.settings.backendFilter === "all" || m.backend === this.plugin.settings.backendFilter
		);

		const fileModels = filteredModels.filter(m => m.modeSupport.includes("file"));

		new Setting(containerEl)
			.setName('Default File Model')
			.setDesc('Select the model for file transcription.')
			.addDropdown(dropdown => {
				fileModels.forEach(m => dropdown.addOption(`${m.backend}::${m.id}`, m.label));

				// Ensure current setting is in list
				if (!fileModels.find(m => `${m.backend}::${m.id}` === this.plugin.settings.modelSize) && fileModels.length > 0) {
                    const first = fileModels[0]!;
					this.plugin.settings.modelSize = `${first.backend}::${first.id}`;
				}

				dropdown.setValue(this.plugin.settings.modelSize);
				dropdown.onChange(async (value) => {
					this.plugin.settings.modelSize = value;
					await this.plugin.saveSettings();
				});
			});

		new Setting(containerEl)
			.setName('Default File Language')
			.setDesc('Language code for file transcription. Use "en" for English (UK). Use "auto" only if you need automatic detection.')
			.addText(text => text
				.setPlaceholder('en')
				.setValue(this.plugin.settings.fileLanguage)
				.onChange(async (value) => {
					this.plugin.settings.fileLanguage = value || 'en';
					await this.plugin.saveSettings();
				}));

		containerEl.createEl('h3', { text: 'Diarization' });

		new Setting(containerEl)
			.setName('Speakers (Default)')
			.setDesc('Number of speakers (0 to disable, auto, 2, 4, etc.). Used as the modal default.')
			.addDropdown(dropdown => dropdown
				.addOption('0', 'None (no diarization)')
				.addOption('auto', 'Auto-detect')
				.addOption('2', '2 speakers')
				.addOption('3', '3 speakers')
				.addOption('4', '4 speakers')
				.addOption('6', '6 speakers')
				.setValue(this.plugin.settings.speakers)
				.onChange(async (value) => {
					this.plugin.settings.speakers = value;
					await this.plugin.saveSettings();
				}));

		containerEl.createEl('h3', { text: 'Output' });

		new Setting(containerEl)
			.setName('Output Format')
			.setDesc('Format to save transcription.')
			.addDropdown(dropdown => dropdown
				.addOption('SRT', 'SRT subtitle file')
				.addOption('TXT', 'Plain text with timestamps')
				.addOption('Both', 'SRT + TXT')
				.addOption('MD', 'Markdown only (no SRT/TXT files)')
				.setValue(this.plugin.settings.outputFormat)
				.onChange(async (value) => {
					this.plugin.settings.outputFormat = value;
					await this.plugin.saveSettings();
					this.display(); // refresh UI
				}));

		new Setting(containerEl)
			.setName('Audio Output Folder')
			.setDesc('Where to save SRT/TXT/MD files (e.g. "Audio/").')
			.addText(text => text
				.setPlaceholder('Audio/')
				.setValue(this.plugin.settings.audioFolder)
				.onChange(async (value) => {
					this.plugin.settings.audioFolder = value || 'Audio/';
					await this.plugin.saveSettings();
				}));

		if (this.plugin.settings.outputFormat !== 'MD') {
			new Setting(containerEl)
				.setName('Create Markdown Note')
				.setDesc('Automatically create a markdown note containing the transcript and embed the file.')
				.addToggle(toggle => toggle
					.setValue(this.plugin.settings.createMarkdownNote)
					.onChange(async (value) => {
						this.plugin.settings.createMarkdownNote = value;
						await this.plugin.saveSettings();
					}));
		}

		new Setting(containerEl)
			.setName('Markdown Paragraph Interval')
			.setDesc('Group transcript into paragraphs by time interval. Paragraph breaks also occur at natural pauses. Set to None to disable grouping (one line per segment).')
			.addDropdown(dropdown => dropdown
				.addOption('0', 'None (one line per segment)')
				.addOption('1', '1 minute')
				.addOption('2', '2 minutes')
				.addOption('5', '5 minutes')
				.addOption('10', '10 minutes')
				.setValue(String(this.plugin.settings.markdownInterval))
				.onChange(async (value) => {
					this.plugin.settings.markdownInterval = parseInt(value, 10);
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName('Natural Pause Threshold (seconds)')
			.setDesc('A gap between segments longer than this (in seconds) triggers a paragraph break within the time interval. Default: 1.5.')
			.addText(text => text
				.setPlaceholder('1.5')
				.setValue(String(this.plugin.settings.markdownPauseGap))
				.onChange(async (value) => {
					this.plugin.settings.markdownPauseGap = parseFloat(value) || 1.5;
					await this.plugin.saveSettings();
				}));

		containerEl.createEl('h3', { text: 'Environment & Models' });

		new Setting(containerEl)
			.setName('Backend Filter')
			.setDesc('Filter model list by backend.')
			.addDropdown(dropdown => dropdown
				.addOption('all', 'All')
				.addOption('python-whisper', 'Python Whisper')
				.addOption('ollama', 'Ollama')
				.setValue(this.plugin.settings.backendFilter)
				.onChange(async (value: "all" | "python-whisper" | "ollama") => {
					this.plugin.settings.backendFilter = value;
					await this.plugin.saveSettings();
					this.display();
				}));

		new Setting(containerEl)
			.setName('Refresh Ollama Models')
			.setDesc('Queries local Ollama instance for installed models.')
			.addButton(btn => btn
				.setButtonText('Refresh')
				.onClick(async () => {
					await this.plugin.modelDiscovery.refreshAll(this.plugin.settings.availableModels);
					new Notice('Models refreshed.');
					this.display();
				}));

		new Setting(containerEl)
			.setName('Custom Python Whisper Models')
			.setDesc('One model name per line. These will appear in the model selector dropdown when transcribing. Model names must match Whisper model identifiers.')
			.addTextArea(text => text
				.setPlaceholder('tiny.en\nbase.en\nsmall.en')
				.setValue(this.plugin.settings.availableModels)
				.onChange(async (value) => {
					this.plugin.settings.availableModels = value;
					await this.plugin.saveSettings();
					await this.plugin.modelDiscovery.refreshAll(this.plugin.settings.availableModels);
					this.display();
				}));

		new Setting(containerEl)
			.setName('Models Folder')
			.setDesc('Absolute path to a folder containing Whisper models. Leave blank to use the plugin\'s built-in models/ folder.')
			.addText(text => text
				.setPlaceholder('/path/to/models or C:\\models')
				.setValue(this.plugin.settings.modelsFolder)
				.onChange(async (value) => {
					this.plugin.settings.modelsFolder = value.trim();
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName('Python Path Override')
			.setDesc('Path to python executable (optional). Required on macOS/Linux.')
			.addText(text => text
				.setPlaceholder('/usr/local/bin/python3')
				.setValue(this.plugin.settings.pythonPath || '')
				.onChange(async (value) => {
					this.plugin.settings.pythonPath = value || null;
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName('Auto-Install on Windows')
			.setDesc('Attempt to install Python/FFmpeg automatically on Windows if missing.')
			.addToggle(toggle => toggle
				.setValue(this.plugin.settings.installOnWindows)
				.onChange(async (value) => {
					this.plugin.settings.installOnWindows = value;
					await this.plugin.saveSettings();
				}));

		containerEl.createEl('h3', { text: 'Live Transcription' });

		const liveModels = filteredModels.filter(m => m.modeSupport.includes("live"));

		new Setting(containerEl)
			.setName('Default Live Model')
			.setDesc('Whisper or Ollama model used for live transcription.')
			.addDropdown(dropdown => {
				liveModels.forEach(m => dropdown.addOption(`${m.backend}::${m.id}`, m.label));
				if (!liveModels.find(m => `${m.backend}::${m.id}` === this.plugin.settings.liveModelSize) && liveModels.length > 0) {
                    const first = liveModels[0]!;
					this.plugin.settings.liveModelSize = `${first.backend}::${first.id}`;
				}
				dropdown.setValue(this.plugin.settings.liveModelSize);
				dropdown.onChange(async (value) => {
					this.plugin.settings.liveModelSize = value;
					await this.plugin.saveSettings();
				});
			});

		new Setting(containerEl)
			.setName('Default Live Language')
			.setDesc('Default language for live dictation. Recommended: en (English UK).')
			.addText(text => text
				.setPlaceholder('en')
				.setValue(this.plugin.settings.liveLanguage)
				.onChange(async (value) => {
					this.plugin.settings.liveLanguage = value || 'en';
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName('Live Chunk Seconds')
			.setDesc('Length of audio chunks for live transcription. Smaller chunks = faster text appearance, slightly more fragmentation.')
			.addText(text => text
				.setPlaceholder('3')
				.setValue(String(this.plugin.settings.liveChunkSeconds))
				.onChange(async (value) => {
					this.plugin.settings.liveChunkSeconds = parseFloat(value) || 3;
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName('Live Chunk Overlap Seconds')
			.setDesc('Amount of overlap between chunks to preserve boundary words. Default: 0.75.')
			.addText(text => text
				.setPlaceholder('0.75')
				.setValue(String(this.plugin.settings.liveChunkOverlapSeconds))
				.onChange(async (value) => {
					this.plugin.settings.liveChunkOverlapSeconds = parseFloat(value) || 0.75;
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName('Silence Gate Threshold (dB)')
			.setDesc('Chunks below this threshold are skipped.')
			.addText(text => text
				.setPlaceholder('-40')
				.setValue(String(this.plugin.settings.liveSilenceGateDb))
				.onChange(async (value) => {
					this.plugin.settings.liveSilenceGateDb = parseFloat(value) || -40;
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName('Live Output Folder')
			.setDesc('Where to save live transcripts and audio chunks.')
			.addText(text => text
				.setPlaceholder('Live_Transcripts/')
				.setValue(this.plugin.settings.liveOutputFolder)
				.onChange(async (value) => {
					this.plugin.settings.liveOutputFolder = value || 'Live_Transcripts/';
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName('Live Diarization Strategy')
			.setDesc('How to handle speaker diarization during live recording.')
			.addDropdown(dropdown => dropdown
				.addOption('off', 'Off (no speakers)')
				.addOption('live', 'Live (per-chunk speakers, may drift)')
				.addOption('finalize', 'Finalize (post-session pass)')
				.setValue(this.plugin.settings.liveDiarizationMode)
				.onChange(async (value: "off" | "live" | "finalize") => {
					this.plugin.settings.liveDiarizationMode = value;
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName('Save Raw Session Audio')
			.setDesc('Save full session WAV file for later reprocessing.')
			.addToggle(toggle => toggle
				.setValue(this.plugin.settings.liveKeepRawAudio)
				.onChange(async (value) => {
					this.plugin.settings.liveKeepRawAudio = value;
					await this.plugin.saveSettings();
				}));
	}
}
