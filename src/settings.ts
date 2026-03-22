import { App, PluginSettingTab, Setting } from "obsidian";
import LocalTranscriberPlugin from "./main";

export interface LocalTranscriberSettings {
	envReady: boolean;
	modelsReady: boolean;
	pythonPath: string | null;
	installOnWindows: boolean;
	modelSize: string;
	language: string;
	speakers: string;
	outputFormat: string;
	audioFolder: string;
	createMarkdownNote: boolean;
}

export const DEFAULT_SETTINGS: LocalTranscriberSettings = {
	envReady: false,
	modelsReady: false,
	pythonPath: null,
	installOnWindows: true,
	modelSize: "base.en",
	language: "auto",
	speakers: "0",
	outputFormat: "SRT",
	audioFolder: "Audio/",
	createMarkdownNote: true
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

		new Setting(containerEl)
			.setName('Model Size')
			.setDesc('Select the Whisper model size (tiny, base, small).')
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
			.setName('Language')
			.setDesc('Select language (e.g. "en" or "auto").')
			.addText(text => text
				.setPlaceholder('auto')
				.setValue(this.plugin.settings.language)
				.onChange(async (value) => {
					this.plugin.settings.language = value || 'auto';
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName('Speakers (Diarization)')
			.setDesc('Number of speakers (0 to disable, auto, 2, 4, etc.).')
			.addText(text => text
				.setPlaceholder('0')
				.setValue(this.plugin.settings.speakers)
				.onChange(async (value) => {
					this.plugin.settings.speakers = value || '0';
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName('Output Format')
			.setDesc('Format to save transcription.')
			.addDropdown(dropdown => dropdown
				.addOption('SRT', 'SRT')
				.addOption('TXT', 'TXT')
				.addOption('Both', 'Both')
				.setValue(this.plugin.settings.outputFormat)
				.onChange(async (value) => {
					this.plugin.settings.outputFormat = value;
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName('Audio Output Folder')
			.setDesc('Where to save SRT/TXT files (e.g. "Audio/").')
			.addText(text => text
				.setPlaceholder('Audio/')
				.setValue(this.plugin.settings.audioFolder)
				.onChange(async (value) => {
					this.plugin.settings.audioFolder = value || 'Audio/';
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName('Create Markdown Note')
			.setDesc('Automatically create a markdown note containing the transcript and embed the file.')
			.addToggle(toggle => toggle
				.setValue(this.plugin.settings.createMarkdownNote)
				.onChange(async (value) => {
					this.plugin.settings.createMarkdownNote = value;
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
	}
}
