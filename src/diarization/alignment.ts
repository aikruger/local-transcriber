import { TranscriptSegment, DiarizationSegment } from '../models/transcript';

function overlap(aStart: number, aEnd: number, bStart: number, bEnd: number): number {
  return Math.max(0, Math.min(aEnd, bEnd) - Math.max(aStart, bStart));
}

export function assignSpeakersToSegments(
  segments: TranscriptSegment[],
  diarization: DiarizationSegment[]
): TranscriptSegment[] {
  console.log("[local-transcriber] Aligning transcript and diarisation (segment-level)", {
    segmentCount: segments.length,
    diarizationCount: diarization.length,
  });

  return segments.map(segment => {
    let bestSpeaker = "UNKNOWN";
    let maxOverlap = 0;
    const segmentDuration = segment.end - segment.start;

    for (const d of diarization) {
      const o = overlap(segment.start, segment.end, d.start, d.end);
      if (o > maxOverlap) {
        maxOverlap = o;
        bestSpeaker = d.speaker;
      }
    }

    const confidence = segmentDuration > 0 ? maxOverlap / segmentDuration : 0;

    if (confidence < 0.3) {
      console.warn("[local-transcriber] Low-confidence speaker attribution", {
        segmentStart: segment.start,
        segmentEnd: segment.end,
        speaker: bestSpeaker,
        confidence,
      });
    }

    return {
      ...segment,
      speaker: bestSpeaker,
      speakerConfidence: confidence
    };
  });
}

export function assignSpeakersToWords(
  segments: TranscriptSegment[],
  diarization: DiarizationSegment[]
): TranscriptSegment[] {
  console.log("[local-transcriber] Aligning transcript and diarisation (word-level)", {
    segmentCount: segments.length,
    diarizationCount: diarization.length,
  });

  return segments.map(segment => {
    if (!segment.words || segment.words.length === 0) {
      // Fallback to segment level if words are missing
      const alignedSegment = assignSpeakersToSegments([segment], diarization)[0];
      return alignedSegment || segment;
    }

    const words = segment.words.map(word => {
      let bestSpeaker = "UNKNOWN";
      let maxOverlap = 0;
      for (const d of diarization) {
        const o = overlap(word.start, word.end, d.start, d.end);
        if (o > maxOverlap) {
          maxOverlap = o;
          bestSpeaker = d.speaker;
        }
      }
      return { ...word, speaker: bestSpeaker };
    });

    // Determine segment majority speaker
    const speakerCounts = new Map<string, number>();
    for (const w of words) {
      const s = (w as any).speaker;
      speakerCounts.set(s, (speakerCounts.get(s) || 0) + 1);
    }

    let bestSpeaker = "UNKNOWN";
    let maxCount = 0;
    for (const [s, count] of speakerCounts.entries()) {
      if (count > maxCount) {
        maxCount = count;
        bestSpeaker = s;
      }
    }

    const confidence = maxCount / words.length;

    if (confidence < 0.5) {
      console.warn("[local-transcriber] Low-confidence segment speaker attribution (word-based)", {
        segmentStart: segment.start,
        segmentEnd: segment.end,
        speaker: bestSpeaker,
        confidence,
      });
    }

    return {
      ...segment,
      words,
      speaker: bestSpeaker,
      speakerConfidence: confidence
    };
  });
}
