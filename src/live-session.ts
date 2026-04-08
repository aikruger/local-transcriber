import { App, TFile } from 'obsidian';
import LocalTranscriberPlugin from './main';
import * as path from 'path';

export interface LiveSegment {
	start: number;
	end: number;
	text: string;
	speaker: string | null;
}

export interface LiveTranscriptionSession {
	id: string;
	startedAt: string;
	status: "idle" | "recording" | "paused" | "stopping" | "finalizing";
	micDeviceId?: string;
	model: string;
	language: string;
	speakers: string;
	chunkSeconds: number;
	overlapSeconds: number;
	sessionDir: string;
	rawAudioPath?: string;
	notePath?: string;
	srtPath?: string;
	txtPath?: string;
	mdPath?: string;
	chunksProcessed: number;
	transcriptSegments: LiveSegment[];
	nextSubtitleIndex: number;
}

export class LiveSessionManager {
	plugin: LocalTranscriberPlugin;
	app: App;

	constructor(plugin: LocalTranscriberPlugin) {
		this.plugin = plugin;
		this.app = plugin.app;
	}

	normalizeText(text: string): string {
		return text.toLowerCase().replace(/[.,!?]/g, '').replace(/\s+/g, ' ').trim();
	}

	deduplicateSegments(existingSegments: LiveSegment[], newSegments: LiveSegment[]): LiveSegment[] {
		if (existingSegments.length === 0) return newSegments;
		if (newSegments.length === 0) return [];

		const lastSegments = existingSegments.slice(-3);
		const filteredNewSegments: LiveSegment[] = [];

		for (const newSeg of newSegments) {
			const normalizedNewText = this.normalizeText(newSeg.text);
			let isDuplicate = false;

			for (const oldSeg of lastSegments) {
				const normalizedOldText = this.normalizeText(oldSeg.text);
				if (normalizedOldText.includes(normalizedNewText)) {
					isDuplicate = true;
					break;
				} else if (normalizedNewText.includes(normalizedOldText)) {
					// The new segment is longer/more complete.
					// Instead of dropping the new segment, we can update the old segment in place,
					// or we just drop the old segment and emit the new one.
					// For simplicity in append-only streams, we might just emit the new one and
					// it will be appended. The duplicate text is already printed, but we can't unprint.
					// We'll consider it NOT a duplicate and emit it, but only the suffix?
					// For an append-only stream, we can't replace old outputs. But if we just replace
					// the in-memory array, it won't fix the written files.
					// Since it's a V1, let's keep it simple: drop the duplicate part if possible,
					// but it's hard to do string math safely.
					// Let's implement what was requested: "prefer the newer segment if it is longer or has a later timestamp."
					// Wait, the prompt says "Keep the last 1-3 emitted segments in memory... If chunk overlap causes partial duplication, prefer the newer segment if it is longer or has a later timestamp."
					// But we are appending to a file. If we emit the new one, it duplicates the prefix.
					// Let's do a prefix overlap check.
					// We find where the old string matches inside the new string and take the suffix.
					// This prevents duplicating the old segment.
					const matchIndex = normalizedNewText.indexOf(normalizedOldText);
					if (matchIndex === 0) {
						// The old text is a prefix of the new text. We can find the approximate split point in the original un-normalized string.
						// This is a naive split that looks for the old text in the new text.
						const originalMatch = newSeg.text.toLowerCase().indexOf(oldSeg.text.toLowerCase());
						if (originalMatch !== -1) {
							newSeg.text = newSeg.text.substring(originalMatch + oldSeg.text.length).trim();
						} else {
							// fallback if exact match fails due to punctuation
							newSeg.text = newSeg.text.substring(oldSeg.text.length).trim();
						}
						if (!newSeg.text) {
							isDuplicate = true;
						}
					} else {
						// Just accept it, since the match is somewhere in the middle.
					}
					break;
				}
			}

			if (!isDuplicate) {
				filteredNewSegments.push(newSeg);
				// also keep our lastSegments updated for the loop
				lastSegments.push(newSeg);
			}
		}

		return filteredNewSegments;
	}

	async appendTxtSegment(session: LiveTranscriptionSession, segment: LiveSegment) {
		const timeStr = this.plugin.outputWriters.formatTimeTxt(segment.start);
		let line = '';
		if (segment.speaker) {
			const speakerNum = segment.speaker.replace('SPEAKER_', '');
			line = `${timeStr} Speaker ${parseInt(speakerNum) + 1}: ${segment.text}\n`;
		} else {
			line = `${timeStr} ${segment.text}\n`;
		}

		if (session.txtPath) {
			await this.appendToFile(session.txtPath, line);
		}
	}

	async appendSrtSegment(session: LiveTranscriptionSession, segment: LiveSegment) {
		let srtContent = `${session.nextSubtitleIndex}\n`;
		srtContent += `${this.plugin.outputWriters.formatTime(segment.start)} --> ${this.plugin.outputWriters.formatTime(segment.end)}\n`;
		if (segment.speaker) {
			const speakerNum = segment.speaker.replace('SPEAKER_', '');
			srtContent += `Speaker ${parseInt(speakerNum) + 1}: ${segment.text}\n\n`;
		} else {
			srtContent += `${segment.text}\n\n`;
		}

		session.nextSubtitleIndex++;

		if (session.srtPath) {
			await this.appendToFile(session.srtPath, srtContent);
		}
	}

	async appendMarkdownSegment(session: LiveTranscriptionSession, segment: LiveSegment) {
		if (session.mdPath) {
			const timeStr = this.plugin.outputWriters.formatTimeTxt(segment.start);
			const speakerPrefix = segment.speaker
				? `**Speaker ${parseInt(segment.speaker.replace('SPEAKER_', '')) + 1}:** `
				: '';

			const mdContent = `${timeStr} ${speakerPrefix}${segment.text}\n\n`;
			await this.appendToFile(session.mdPath, mdContent);
		}
	}

	async appendToFile(filePath: string, content: string) {
		const file = this.app.vault.getAbstractFileByPath(filePath);
		if (file instanceof TFile) {
			const oldContent = await this.app.vault.read(file);
			await this.app.vault.modify(file, oldContent + content);
		} else {
			await this.app.vault.create(filePath, content);
		}
	}

	async initSessionNote(session: LiveTranscriptionSession) {
		if (session.mdPath) {
			const file = this.app.vault.getAbstractFileByPath(session.mdPath);
			if (!file) {
				const header = `# Live Transcript - ${session.startedAt}\n\nStatus: Recording\nModel: ${session.model}\nLanguage: ${session.language}\nSpeakers: ${session.speakers}\n\n## Transcript\n\n`;
				await this.app.vault.create(session.mdPath, header);
			}
		}

		if (session.srtPath) {
			const file = this.app.vault.getAbstractFileByPath(session.srtPath);
			if (!file) {
				await this.app.vault.create(session.srtPath, '');
			}
		}
		if (session.txtPath) {
			const file = this.app.vault.getAbstractFileByPath(session.txtPath);
			if (!file) {
				await this.app.vault.create(session.txtPath, '');
			}
		}
	}

	async finalizeSessionOutputs(session: LiveTranscriptionSession) {
		if (session.mdPath) {
			const file = this.app.vault.getAbstractFileByPath(session.mdPath);
			if (file instanceof TFile) {
				let content = await this.app.vault.read(file);
				content = content.replace('Status: Recording', 'Status: Finalized');
				await this.app.vault.modify(file, content);
			}
		}
	}
}
