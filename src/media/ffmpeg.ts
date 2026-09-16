import { spawn } from 'child_process';

export async function convertToWav(
  inputPath: string,
  outputPath: string,
  options: { sampleRate?: number; channels?: number; signal?: AbortSignal } = {}
): Promise<void> {
  const sampleRate = options.sampleRate || 16000;
  const channels = options.channels || 1;
  const signal = options.signal;

  console.log("[local-transcriber] Extracting audio to WAV", { inputPath, wavPath: outputPath });

  return new Promise((resolve, reject) => {
    const ffmpeg = spawn('ffmpeg', [
      '-y',
      '-i', inputPath,
      '-ac', channels.toString(),
      '-ar', sampleRate.toString(),
      '-vn',
      outputPath
    ], { signal });

    let stderr = '';

    ffmpeg.stderr.on('data', (data) => {
      stderr += data.toString();
    });

    ffmpeg.on('close', (code) => {
      if (code !== 0) {
        console.error("[local-transcriber] FFmpeg failed", { exitCode: code, stderr });
        reject(new Error(`FFmpeg failed with code ${code}: ${stderr}`));
        return;
      }
      resolve();
    });

    ffmpeg.on('error', (err) => {
      reject(err);
    });
  });
}
