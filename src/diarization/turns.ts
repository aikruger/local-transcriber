import { TranscriptSegment, TranscriptWord } from '../models/transcript';

export interface Turn {
  start: number;
  end: number;
  speaker: string;
  text: string;
  words: TranscriptWord[];
}

export function buildSpeakerTurns(
  segments: TranscriptSegment[],
  options: {
    maxGapSeconds: number;
    minTurnDurationSeconds?: number;
  }
): Turn[] {
  const turns: Turn[] = [];

  if (segments.length === 0) return turns;

  let currentTurn: Turn | null = null;

  for (const segment of segments) {
    // We expect the segment to already have speakers assigned at this point
    const segmentSpeaker = segment.speaker || 'UNKNOWN';

    // Grouping logic based on words if available, else fallback to segments
    if (segment.words && segment.words.length > 0) {
      for (const word of segment.words) {
        const wordSpeaker = (word as any).speaker || segmentSpeaker;

        if (!currentTurn) {
          currentTurn = {
            start: word.start,
            end: word.end,
            speaker: wordSpeaker,
            text: word.text,
            words: [word]
          };
        } else {
          const gap = word.start - currentTurn.end;
          if (wordSpeaker !== currentTurn.speaker || gap > options.maxGapSeconds) {
            // End current turn and start a new one
            turns.push(currentTurn);
            currentTurn = {
              start: word.start,
              end: word.end,
              speaker: wordSpeaker,
              text: word.text,
              words: [word]
            };
          } else {
            // Append to current turn
            currentTurn.end = word.end;
            // Trim leading space if necessary, but usually just join with space
            currentTurn.text += (word.text.startsWith(' ') || currentTurn.text.endsWith(' ') ? '' : ' ') + word.text.trim();
            currentTurn.words.push(word);
          }
        }
      }
    } else {
      // Fallback to segment-level logic
      if (!currentTurn) {
        currentTurn = {
          start: segment.start,
          end: segment.end,
          speaker: segmentSpeaker,
          text: segment.text,
          words: []
        };
      } else {
        const gap = segment.start - currentTurn.end;
        if (segmentSpeaker !== currentTurn.speaker || gap > options.maxGapSeconds) {
          turns.push(currentTurn);
          currentTurn = {
            start: segment.start,
            end: segment.end,
            speaker: segmentSpeaker,
            text: segment.text,
            words: []
          };
        } else {
          currentTurn.end = segment.end;
          currentTurn.text += ' ' + segment.text;
        }
      }
    }
  }

  if (currentTurn) {
    turns.push(currentTurn);
  }

  // Clean up texts
  for (const t of turns) {
    t.text = t.text.trim();
  }

  console.log("[local-transcriber] Built speaker turns", {
    turnCount: turns.length,
    speakers: Array.from(new Set(turns.map(t => t.speaker))),
  });

  return turns;
}
