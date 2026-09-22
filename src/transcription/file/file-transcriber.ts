import { Notice, App } from 'obsidian';
import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs';
import * as crypto from 'crypto';
import type LocalTranscriberPlugin from '../../main';
import { PythonWhisperFileBackend } from './python-whisper';
import { diarizeAudio } from '../../diarization/service';
import { assignSpeakersToSegments } from '../../diarization/alignment';

export async function runFileTranscriptionWithDiarization(
  plugin: LocalTranscriberPlugin,
  file: File,
  numSpeakers: number,
  whisperModel: string
) {
  console.log('[FileTranscriber] Starting pipeline', { name: file.name, numSpeakers, whisperModel });

  const safeName = file.name.replace(/[^a-z0-9._-]/gi, '_');

  const tempRoot = path.join(os.tmpdir(), 'local-transcriber');
  await fs.promises.mkdir(tempRoot, { recursive: true });

  const jobId = `${Date.now()}-${crypto.randomUUID()}`;
  const tempDir = path.join(tempRoot, jobId);
  await fs.promises.mkdir(tempDir, { recursive: true });

  const tempMediaPath = path.join(tempDir, safeName);

  console.log('[FileTranscriber] Writing temporary media outside vault', {
    originalName: file.name,
    tempMediaPath,
    size: file.size,
  });

  const buffer = Buffer.from(await file.arrayBuffer());
  await fs.promises.writeFile(tempMediaPath, buffer);

  try {
    // 2. Transcribe
    console.log('[FileTranscriber] Running Whisper transcription');
    const backend = new PythonWhisperFileBackend(plugin);
    const options = {
        inputPath: tempMediaPath,
        modelId: whisperModel.split('::').slice(1).join('::') || whisperModel,
        language: plugin.settings.fileLanguage,
        speakers: "0",
        modelsDir: plugin.pythonEnv.getModelsDir()
    };

    let transcriptionResult: any;
    try {
        transcriptionResult = await backend.transcribeFile(options, (msg) => {
            // Optional: Handle progress events if needed
        });
        console.log('[FileTranscriber] Whisper transcription complete', {
            segmentCount: transcriptionResult.segments.length,
        });
    } catch (e: any) {
        console.error('[FileTranscriber] Error in transcription step', e);
        throw e;
    }

    // 3. Diarization
    console.log('[FileTranscriber] Running diarization with speakers', numSpeakers);
    let diarizationResult: any;
    try {
        const diarizationOptions = {
            audioPath: tempMediaPath,
            expectedSpeakers: numSpeakers
        };
        const app = plugin.app;
        const adapter: any = app.vault.adapter;
        const vaultPath = adapter && adapter.getBasePath ? adapter.getBasePath() : '';
        const pluginDir = path.join(vaultPath, app.vault.configDir, 'plugins', plugin.manifest.id);

        diarizationResult = await diarizeAudio(plugin.pythonEnv.getPythonExecutable(), pluginDir, diarizationOptions);
        console.log('[FileTranscriber] Diarization complete', {
            turnCount: diarizationResult.length,
        });
    } catch (e: any) {
        console.error('[FileTranscriber] Error in diarization step', e);
        throw e;
    }

    // 4. Align diarization to transcript
    console.log('[FileTranscriber] Aligning diarization to transcript');
    let aligned: any;
    try {
        aligned = assignSpeakersToSegments(transcriptionResult.segments, diarizationResult);
    } catch (e: any) {
        console.error('[FileTranscriber] Error in alignment step', e);
        throw e;
    }

    // 5. Write Markdown next to original file
    const stem = safeName.replace(/\.[^.]+$/, '') + '.transcript';
    console.log('[FileTranscriber] Writing outputs to', stem);

    // We will still place the outputs to the expected Obsidian vault folder based on audioFolder.
    // The previous implementation overrode this to tmpDir, but the original requirement is to have it
    // in the plugin's configured output folder or 'Audio'
    try {
        await plugin.outputWriters.saveOutputs(stem, aligned, plugin.settings.markdownInterval, plugin.settings.markdownPauseGap);
    } catch (e: any) {
        console.error('[FileTranscriber] Error in output step', e);
        throw e;
    }

    new Notice(`Transcription complete! Transcripts saved.`);
  } finally {
    console.log('[FileTranscriber] Removing temporary job directory', { tempDir });
    try {
        await fs.promises.rm(tempDir, { recursive: true, force: true });
    } catch(e) {
        console.error('[FileTranscriber] Failed to remove temp job directory', e);
    }
  }
}
