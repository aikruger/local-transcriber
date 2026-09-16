import { DiarizationOptions } from './types';
import { DiarizationSegment } from '../models/transcript';
import { PyannoteWorker } from './pyannote-worker';

export class DiarizationService {
  private worker: PyannoteWorker;

  constructor(pythonExecutable: string, pluginDir: string) {
    this.worker = new PyannoteWorker(pythonExecutable, pluginDir);
  }

  async diarizeAudio(options: DiarizationOptions): Promise<DiarizationSegment[]> {
    return this.worker.diarize(options);
  }
}

export async function diarizeAudio(
  pythonExecutable: string,
  pluginDir: string,
  options: DiarizationOptions
): Promise<DiarizationSegment[]> {
  const service = new DiarizationService(pythonExecutable, pluginDir);
  return service.diarizeAudio(options);
}
