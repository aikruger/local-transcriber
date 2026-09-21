import { Notice, App } from 'obsidian';
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

  // 1. Persist file to disk (plugin.app is your Obsidian App)
  const basePath = (plugin.app as any).vault.adapter.getBasePath?.() as string | undefined;
  if (!basePath) {
    throw new Error('Cannot determine vault base path');
  }

  // Choose a temp directory inside the vault or system temp; here we use a subfolder in vault
  const tmpDir = 'local-transcriber-tmp';
  await (plugin.app.vault.adapter as any).mkdir(tmpDir).catch(() => {});

  const safeName = file.name.replace(/[^a-z0-9._-]/gi, '_');
  const tmpPath = `${tmpDir}/${safeName}`;

  // Write ArrayBuffer to vault adapter
  const buffer = await file.arrayBuffer();
  await (plugin.app.vault.adapter as any).writeBinary(tmpPath, buffer);
  console.log('[FileTranscriber] Wrote temp file', tmpPath);

  const fullPath = [basePath, tmpPath].join('/');

  try {
    // 2. Transcribe
    console.log('[FileTranscriber] Running Whisper transcription');
    const backend = new PythonWhisperFileBackend(plugin);
    const options = {
        inputPath: fullPath,
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
    } catch (e: any) {
        console.error('[FileTranscriber] Error in transcription step', e);
        throw e;
    }

    // 3. Diarization
    console.log('[FileTranscriber] Running diarization with speakers', numSpeakers);
    let diarizationResult: any;
    try {
        const diarizationOptions = {
            audioPath: fullPath,
            expectedSpeakers: numSpeakers
        };
        const app = plugin.app;
        const adapter: any = app.vault.adapter;
        const vaultPath = adapter && adapter.getBasePath ? adapter.getBasePath() : '';
        const pluginDir = [vaultPath, app.vault.configDir, 'plugins', plugin.manifest.id].join('/');

        diarizationResult = await diarizeAudio(plugin.pythonEnv.getPythonExecutable(), pluginDir, diarizationOptions);
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

    try {
        await plugin.outputWriters.saveOutputs(stem, aligned, plugin.settings.markdownInterval, plugin.settings.markdownPauseGap, tmpDir);
    } catch (e: any) {
        console.error('[FileTranscriber] Error in output step', e);
        throw e;
    }

    new Notice(`Transcription complete: ${tmpDir}/${stem}.md`);
  } finally {
    // Optionally clean up temp files if desired
    // await plugin.app.vault.adapter.remove(tmpPath);
  }
}
