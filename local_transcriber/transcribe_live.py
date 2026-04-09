#!/usr/bin/env python3
"""
Live Transcription script for local-transcriber plugin.
Optimized for chunk processing and structured event output.
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
    parser.add_argument("--model", default="base.en")
    parser.add_argument("--language", default="auto")
    parser.add_argument("--speakers", default="0")
    parser.add_argument("--models-dir", default=None)
    parser.add_argument("--chunk-start", type=float, default=0.0)
    parser.add_argument("--session-id", default="live")
    parser.add_argument("--output-format", default="jsonl")
    parser.add_argument("--word-timestamps", action="store_true", default=True)
    parser.add_argument("--no-diarization", action="store_true")
    args = parser.parse_args()

    language = None if args.language == "auto" else args.language
    models_dir = args.models_dir

    # Convert to 16kHz mono WAV if needed
    temp_wav = tempfile.mktemp(suffix=".wav")
    try:
        subprocess.run(
            ["ffmpeg", "-y", "-i", args.input, "-ac", "1", "-ar", "16000", "-vn", temp_wav],
            check=True, capture_output=True
        )
    except subprocess.CalledProcessError as e:
        emit({"type": "error", "error": f"ffmpeg failed: {e.stderr.decode()}"})
        sys.exit(2)

    try:
        import whisper
        # For live transcription, use the default models directory if available
        model = whisper.load_model(args.model, download_root=models_dir)
        result = model.transcribe(temp_wav, language=language, word_timestamps=args.word_timestamps)
    except Exception as e:
        emit({"type": "error", "error": f"Whisper failed: {str(e)}"})
        sys.exit(2)

    chunk_filename = os.path.basename(args.input)
    duration = result["segments"][-1]["end"] if result.get("segments") else 0.0

    emit({
        "type": "meta",
        "chunk": chunk_filename,
        "chunkStart": args.chunk_start,
        "duration": duration
    })

    segments = []

    # Diarization is intentionally disabled for Live Dictation UX but we leave the arg handling.
    for seg in result.get("segments", []):
        text = seg["text"].strip()
        if text:
            # Emit natural text for insertion
            entry = {
                "type": "segment",
                "start": seg["start"],
                "end": seg["end"],
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

    # Cleanup
    try:
        os.remove(temp_wav)
    except Exception:
        pass

    sys.exit(0)


if __name__ == "__main__":
    main()
