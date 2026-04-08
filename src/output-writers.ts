import { App, TFile } from 'obsidian';
import LocalTranscriberPlugin from './main';

export class OutputWriters {
	plugin: LocalTranscriberPlugin;
	app: App;

	constructor(plugin: LocalTranscriberPlugin) {
		this.plugin = plugin;
		this.app = plugin.app;
	}

	formatTime(seconds: number): string {
		const h = Math.floor(seconds / 3600);
		const m = Math.floor((seconds % 3600) / 60);
		const s = Math.floor(seconds % 60);
		const ms = Math.floor((seconds - Math.floor(seconds)) * 1000);
		const pad = (num: number, size: number) => ('000' + num).slice(size * -1);
		return `${pad(h, 2)}:${pad(m, 2)}:${pad(s, 2)},${pad(ms, 3)}`;
	}

	formatTimeTxt(seconds: number): string {
		const m = Math.floor(seconds / 60);
		const s = Math.floor(seconds % 60);
		const ms = Math.floor((seconds - Math.floor(seconds)) * 100);
		const pad = (num: number, size: number) => ('00' + num).slice(size * -1);
		return `[${pad(m, 2)}:${pad(s, 2)}.${pad(ms, 2)}]`;
	}

	async saveOutputs(
		stem: string,
		segments: any[],
		intervalOverride?: number,
		pauseGapOverride?: number
	) {
		const interval = intervalOverride ?? this.plugin.settings.markdownInterval;
		const pauseGap = pauseGapOverride ?? this.plugin.settings.markdownPauseGap;

		const folderPath = this.plugin.settings.audioFolder.endsWith('/') ? this.plugin.settings.audioFolder : this.plugin.settings.audioFolder + '/';

		if (!await this.app.vault.adapter.exists(folderPath.replace(/\/$/, ''))) {
			await this.app.vault.createFolder(folderPath.replace(/\/$/, ''));
		}

		if (['SRT', 'Both'].includes(this.plugin.settings.outputFormat)) {
			let srtContent = '';
			segments.forEach((seg, i) => {
				srtContent += `${i + 1}\n`;
				srtContent += `${this.formatTime(seg.start)} --> ${this.formatTime(seg.end)}\n`;
				if (seg.speaker) {
					const speakerNum = seg.speaker.replace('SPEAKER_', '');
					srtContent += `Speaker ${parseInt(speakerNum) + 1}: ${seg.text}\n\n`;
				} else {
					srtContent += `${seg.text}\n\n`;
				}
			});

			const srtPath = `${folderPath}${stem}.srt`;
			const existing = this.app.vault.getAbstractFileByPath(srtPath);
			if (existing instanceof TFile) {
				await this.app.vault.modify(existing, srtContent.trim());
			} else {
				await this.app.vault.create(srtPath, srtContent.trim());
			}
		}

		if (['TXT', 'Both'].includes(this.plugin.settings.outputFormat)) {
			let txtContent = '';
			segments.forEach(seg => {
				const timeStr = this.formatTimeTxt(seg.start);
				if (seg.speaker) {
					const speakerNum = seg.speaker.replace('SPEAKER_', '');
					txtContent += `${timeStr} Speaker ${parseInt(speakerNum) + 1}: ${seg.text}\n`;
				} else {
					txtContent += `${timeStr} ${seg.text}\n`;
				}
			});

			const txtPath = `${folderPath}${stem}.txt`;
			const existing = this.app.vault.getAbstractFileByPath(txtPath);
			if (existing instanceof TFile) {
				await this.app.vault.modify(existing, txtContent.trim());
			} else {
				await this.app.vault.create(txtPath, txtContent.trim());
			}
		}

		const createMD = this.plugin.settings.outputFormat === 'MD' || this.plugin.settings.createMarkdownNote;
		const mdOnlyMode = this.plugin.settings.outputFormat === 'MD';

		if (createMD) {
			let md = `# Transcription: ${stem}\n\n`;

			if (!mdOnlyMode) {
				const embedFile = ['SRT', 'Both'].includes(this.plugin.settings.outputFormat)
					? `${folderPath}${stem}.srt`
					: `${folderPath}${stem}.txt`;
				md += `![[${embedFile}]]\n\n---\n\n`;
			}

			md += this.buildMarkdownTranscript(segments, interval, pauseGap);

			const mdPath = `${folderPath}${stem}.md`;
			const existingMd = this.app.vault.getAbstractFileByPath(mdPath);
			if (existingMd instanceof TFile) {
				await this.app.vault.modify(existingMd, md.trim());
			} else {
				await this.app.vault.create(mdPath, md.trim());
			}
		}
	}

	buildMarkdownTranscript(
		segments: any[],
		markdownInterval: number = this.plugin.settings.markdownInterval,
		markdownPauseGap: number = this.plugin.settings.markdownPauseGap
	): string {
		if (!segments || segments.length === 0) return '_No speech detected._\n';

		const intervalSec = markdownInterval * 60;
		const pauseGap = markdownPauseGap;

		let output = '';
		let paragraphLines: string[] = [];
		let currentBlockStart = segments[0].start;

		const flushParagraph = (blockTimestamp: number) => {
			if (paragraphLines.length === 0) return;
			const label = this.formatTimeTxt(blockTimestamp);
			output += `**${label}**\n\n`;
			output += paragraphLines.join(' ') + '\n\n';
			paragraphLines = [];
		};

		for (let i = 0; i < segments.length; i++) {
			const seg = segments[i];
			const prev = i > 0 ? segments[i - 1] : null;

			const intervalBoundary = intervalSec > 0 && (seg.start - currentBlockStart) >= intervalSec;
			const naturalPause = prev !== null && (seg.start - prev.end) >= pauseGap;

			if (intervalBoundary || (naturalPause && intervalSec > 0)) {
				flushParagraph(currentBlockStart);
				currentBlockStart = seg.start;
			} else if (naturalPause && intervalSec === 0) {
				if (paragraphLines.length > 0) {
					output += paragraphLines.join(' ') + '\n\n';
					paragraphLines = [];
				}
				currentBlockStart = seg.start;
			}

			const speakerPrefix = seg.speaker
				? `**Speaker ${parseInt(seg.speaker.replace('SPEAKER_', '')) + 1}:** `
				: '';

			if (intervalSec === 0) {
				const ts = this.formatTimeTxt(seg.start);
				output += `${ts} ${speakerPrefix}${seg.text}\n\n`;
			} else {
				paragraphLines.push(`${speakerPrefix}${seg.text.trim()}`);
			}
		}

		if (intervalSec > 0) flushParagraph(currentBlockStart);

		return output;
	}
}
