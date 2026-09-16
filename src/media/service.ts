import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs/promises';
import { PrepareAudioOptions, PreparedAudio, MediaInfo } from './types';
import { probeMedia } from './ffprobe';
import { convertToWav } from './ffmpeg';

export async function prepareAudioForTranscription(
  options: PrepareAudioOptions
): Promise<PreparedAudio> {
  const info = await probeMedia(options.inputPath, options.signal);

  if (!info.hasAudio) {
    throw new Error('Input file has no audio stream');
  }

  const outputDir = options.outputDir || os.tmpdir();
  const filename = `audio_${Date.now()}_${Math.random().toString(36).substring(7)}.wav`;
  const wavPath = path.join(outputDir, filename);

  await convertToWav(options.inputPath, wavPath, {
    sampleRate: options.sampleRate,
    channels: options.channels,
    signal: options.signal
  });

  const cleanup = async () => {
    try {
      await fs.unlink(wavPath);
    } catch (err: any) {
      if (err.code !== 'ENOENT') {
        console.error("[local-transcriber] Failed to cleanup temporary WAV file", { path: wavPath, error: err });
      }
    }
  };

  return {
    wavPath,
    duration: info.duration,
    cleanup
  };
}
