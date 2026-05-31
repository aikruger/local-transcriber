#!/usr/bin/env python3
"""
Live Transcription script — uses faster-whisper for low-latency chunk processing.
Output format is JSONL: one JSON object per line on stdout.
"""

import sys
import os
import json
import argparse
import tempfile
import subprocess


def emit(data: dict):
    print(json.dumps(data), flush=True)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--input", required=True)
    parser.add_argument("--model", default="tiny")
    parser.add_argument("--language", default="auto")
    parser.add_argument("--speakers", default="0")
    parser.add_argument("--models-dir", default=None)
    parser.add_argument("--chunk-start", type=float, default=0.0)
    parser.add_argument("--session-id", default="live")
    parser.add_argument("--output-format", default="jsonl")
    parser.add_argument("--word-timestamps", action="store_true", default=False)
    parser.add_argument("--no-diarization", action="store_true")
    parser.add_argument("--input-is-normalized-wav", action="store_true")
    args = parser.parse_args()

    language = None if args.language in ("auto", "") else args.language

    if args.input_is_normalized_wav:
        target_wav = args.input
        temp_wav = None
    else:
        temp_wav = tempfile.mktemp(suffix=".wav")
        try:
            subprocess.run(
                ["ffmpeg", "-y", "-i", args.input,
                 "-ac", "1", "-ar", "16000", "-vn", temp_wav],
                check=True, capture_output=True
            )
        except subprocess.CalledProcessError as e:
            emit({"type": "error", "error": f"ffmpeg failed: {e.stderr.decode()}"})
            sys.exit(2)
        target_wav = temp_wav

    try:
        from faster_whisper import WhisperModel

        # int8 quantisation on CPU: ~4-8x faster than openai-whisper
        model = WhisperModel(
            args.model,
            device="cpu",
            compute_type="int8",
            download_root=args.models_dir
        )

        segments_iter, info = model.transcribe(
            target_wav,
            language=language,
            vad_filter=True,           # suppress hallucinations during silence
            vad_parameters={"min_silence_duration_ms": 300},
            word_timestamps=False,     # not needed for live dictation, saves time
            beam_size=1                # greedy decode — faster, still accurate for dictation
        )

        # faster-whisper returns a generator; consume it fully
        raw_segments = list(segments_iter)

    except Exception as e:
        emit({"type": "error", "error": f"faster-whisper failed: {str(e)}"})
        sys.exit(2)

    chunk_filename = os.path.basename(args.input)
    duration = raw_segments[-1].end if raw_segments else 0.0

    emit({
        "type": "meta",
        "chunk": chunk_filename,
        "chunkStart": args.chunk_start,
        "duration": duration
    })

    segments = []

    for seg in raw_segments:
        text = seg.text.strip()
        if text:
            entry = {
                "type": "segment",
                "start": seg.start,
                "end": seg.end,
                "text": text,
                "speaker": None
            }
            emit(entry)
            segments.append(entry)

    emit({
        "type": "result",
        "chunk": chunk_filename,
        "segmentCount": len(segments),
        "segments": segments
    })

    if temp_wav:
        try:
            os.remove(temp_wav)
        except Exception:
            pass

    sys.exit(0)


if __name__ == "__main__":
    main()
