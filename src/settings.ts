import { App, PluginSettingTab, Setting } from "obsidian";
import LocalTranscriberPlugin from "./main";

export interface LocalTranscriberSettings {
	envReady: boolean;
	modelsReady: boolean;
	pythonPath: string | null;
	installOnWindows: boolean;
	modelSize: string;
	modelsFolder: string;
	availableModels: string;
	language: string;
	speakers: string;
	outputFormat: string;
	audioFolder: string;
	createMarkdownNote: boolean;
	markdownInterval: number;
	markdownPauseGap: number;
}

export const DEFAULT_SETTINGS: LocalTranscriberSettings = {
	envReady: false,
	modelsReady: false,
	pythonPath: null,
	installOnWindows: true,
	modelSize: "base.en",
	modelsFolder: "",
	availableModels: "tiny.en\nbase.en\nsmall.en",
	language: "auto",
	speakers: "0",
	outputFormat: "SRT",
	audioFolder: "Audio/",
	createMarkdownNote: true,
	markdownInterval: 5,
	markdownPauseGap: 1.5
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

		new Setting(containerEl)
			.setName('Model Size')
			.setDesc('Default Whisper model size.')
			.addDropdown(dropdown => dropdown
				.addOption('tiny.en', 'Tiny (English)')
				.addOption('base.en', 'Base (English)')
				.addOption('small.en', 'Small (English)')
				.setValue(this.plugin.settings.modelSize)
				.onChange(async (value) => {
					this.plugin.settings.modelSize = value;
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName('Models Folder')
			.setDesc('Absolute path to a folder containing Whisper models. Leave blank to use the plugin\'s built-in models/ folder. Useful if you already have models downloaded (e.g. via Ollama or Hugging Face).')
			.addText(text => text
				.setPlaceholder('/path/to/models or C:\\models')
				.setValue(this.plugin.settings.modelsFolder)
				.onChange(async (value) => {
					this.plugin.settings.modelsFolder = value.trim();
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName('Available Models')
			.setDesc('One model name per line. These will appear in the model selector dropdown when transcribing. Model names must match Whisper model identifiers (tiny.en, base.en, small.en, medium, large-v3, etc.).')
			.addTextArea(text => text
				.setPlaceholder('tiny.en\nbase.en\nsmall.en')
				.setValue(this.plugin.settings.availableModels)
				.onChange(async (value) => {
					this.plugin.settings.availableModels = value;
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName('Language')
			.setDesc('Select language (e.g. "en" or "auto").')
			.addText(text => text
				.setPlaceholder('auto')
				.setValue(this.plugin.settings.language)
				.onChange(async (value) => {
					this.plugin.settings.language = value || 'auto';
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
					// Trigger a UI refresh to potentially hide the "Create Markdown Note" toggle if we are in MD only mode.
					this.display();
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

		containerEl.createEl('h3', { text: 'Environment' });

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
	}
}
