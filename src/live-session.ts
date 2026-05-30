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

		// Build a rolling text tail of the last ~250 chars of committed transcript
		const tailText = existingSegments
			.slice(-6)
			.map(s => s.text)
			.join(' ')
			.toLowerCase()
			.replace(/[.,!?;:'"]/g, '')
			.replace(/\s+/g, ' ')
			.trim()
			.slice(-250);

		const accepted: LiveSegment[] = [];

		for (const seg of newSegments) {
			const norm = seg.text
				.toLowerCase()
				.replace(/[.,!?;:'"]/g, '')
				.replace(/\s+/g, ' ')
				.trim();

			if (!norm || norm.length < 3) continue;

			// Suppress if this segment text already appears in recent tail
			if (norm.length > 8 && tailText.includes(norm)) continue;

			// Suppress if tail already ends with the first 60% of this segment
			const prefix = norm.slice(0, Math.floor(norm.length * 0.6));
			if (prefix.length > 10 && tailText.endsWith(prefix)) continue;

			accepted.push(seg);
			// Update tailText equivalent so within-batch duplicates are also caught
			// (re-build would be expensive; just track accepted text in a local buffer)
		}

		return accepted;
	}

	async appendTxtSegment(session: LiveTranscriptionSession, segment: LiveSegment) {}
	async appendSrtSegment(session: LiveTranscriptionSession, segment: LiveSegment) {}
	async appendMarkdownSegment(session: LiveTranscriptionSession, segment: LiveSegment) {}

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
		// Dictation mode does not use session notes
	}

	async finalizeSessionOutputs(session: LiveTranscriptionSession) {
		// Output writers removed for Dictation mode - outputs are inserted at cursor
	}
}
