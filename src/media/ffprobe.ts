import { spawn } from 'child_process';
import { MediaInfo } from './types';

export async function probeMedia(inputPath: string, signal?: AbortSignal): Promise<MediaInfo> {
  console.log("[local-transcriber] Probing media", { path: inputPath });
  return new Promise((resolve, reject) => {
    const ffprobe = spawn('ffprobe', [
      '-v', 'quiet',
      '-print_format', 'json',
      '-show_format',
      '-show_streams',
      inputPath
    ], { signal });

    let stdout = '';
    let stderr = '';

    ffprobe.stdout.on('data', (data) => {
      stdout += data.toString();
    });

    ffprobe.stderr.on('data', (data) => {
      stderr += data.toString();
    });

    ffprobe.on('close', (code) => {
      if (code !== 0) {
        console.error("[local-transcriber] ffprobe failed", { exitCode: code, stderr });
        reject(new Error(`ffprobe failed with code ${code}: ${stderr}`));
        return;
      }

      try {
        const info = JSON.parse(stdout);
        const streams = info.streams || [];
        const audioStream = streams.find((s: any) => s.codec_type === 'audio');
        const videoStream = streams.find((s: any) => s.codec_type === 'video');

        const result: MediaInfo = {
          path: inputPath,
          duration: parseFloat(info.format?.duration || audioStream?.duration || '0') || undefined,
          hasAudio: !!audioStream,
          hasVideo: !!videoStream,
          audioCodec: audioStream?.codec_name,
          videoCodec: videoStream?.codec_name,
        };

        if (!result.hasAudio) {
            console.warn("[local-transcriber] No audio stream detected", { path: inputPath });
        }

        resolve(result);
      } catch (err: any) {
        reject(new Error(`Failed to parse ffprobe output: ${err.message}`));
      }
    });

    ffprobe.on('error', (err) => {
      reject(err);
    });
  });
}
