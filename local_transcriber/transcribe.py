#!/usr/bin/env python3
"""
Transcription script for local-transcriber plugin.
Outputs a single JSON object to stdout.
"""

import sys
import os
import json
import argparse
import tempfile
import subprocess
import time
from typing import Any
import traceback

def emit(event: str, **payload: Any) -> None:
    message = {
        "type": event,
        "timestamp": time.time(),
        **payload,
    }
    print(json.dumps(message, ensure_ascii=False), flush=True)

def main():
    emit("worker_started", pid=os.getpid(), python=sys.executable)
    parser = argparse.ArgumentParser()
    parser.add_argument("--input", required=True)
    parser.add_argument("--model", default="base.en")
    parser.add_argument("--language", default="auto")
    parser.add_argument("--speakers", default="0")
    parser.add_argument("--models-dir", default=None)
    args = parser.parse_args()

    emit("request_received", audio_path=args.input, model=args.model)

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
        emit("error", message=f"ffmpeg failed: {e.stderr.decode()}", error_type="CalledProcessError")
        print(f"ffmpeg failed: {e.stderr.decode()}", file=sys.stderr, flush=True)
        sys.exit(2)

    try:
        emit("loading_model", model=args.model)
        from faster_whisper import WhisperModel
        device = "cuda" if os.environ.get("CUDA_VISIBLE_DEVICES") else "cpu"
        compute_type = "int8" if device == "cpu" else "float16"
        model = WhisperModel(args.model, device=device, compute_type=compute_type, download_root=models_dir)
        emit("model_loaded", model=args.model)

        emit("starting_transcription", audio_path=temp_wav)

        segments_generator, info = model.transcribe(
            temp_wav,
            language=language,
            word_timestamps=True
        )
        emit("transcription_started", detected_language=getattr(info, "language", None))

        result_segments = []
        for index, segment in enumerate(segments_generator, start=1):
            result_segments.append({
                "start": segment.start,
                "end": segment.end,
                "text": segment.text.strip(),
                "speaker": None
            })

            if index == 1 or index % 5 == 0:
                emit(
                    "transcription_progress",
                    segment_count=index,
                    latest_end_seconds=segment.end,
                )
    except Exception as exc:
        emit("error", message=str(exc), error_type=type(exc).__name__)
        traceback.print_exc(file=sys.stderr)
        sys.stderr.flush()
        sys.exit(2)

    diarization_error = None
    # Optional diarization
    if args.speakers != "0":
        try:
            from pyannote.audio import Pipeline
            pipeline = Pipeline.from_pretrained(
                "pyannote/speaker-diarization-3.1",
                use_auth_token=False
            )
            # Apply fixed speakers if not auto
            num_speakers = None
            if args.speakers != "auto":
                try:
                    num_speakers = int(args.speakers)
                except ValueError:
                    pass

            if num_speakers:
                diarization = pipeline(temp_wav, num_speakers=num_speakers)
            else:
                diarization = pipeline(temp_wav)

            intervals = []
            for turn, _, speaker in diarization.itertracks(yield_label=True):
                intervals.append((turn.start, turn.end, speaker))

            for seg in result_segments:
                s_start = seg["start"]
                s_end = seg["end"]

                speaker_overlaps = {}
                for (i_start, i_end, sp) in intervals:
                    # Calculate overlap
                    overlap_start = max(s_start, i_start)
                    overlap_end = min(s_end, i_end)
                    overlap_duration = max(0, overlap_end - overlap_start)

                    if overlap_duration > 0:
                        speaker_overlaps[sp] = speaker_overlaps.get(sp, 0) + overlap_duration

                if speaker_overlaps:
                    # Assign the speaker with maximum overlap
                    best_speaker = max(speaker_overlaps, key=speaker_overlaps.get)
                    seg["speaker"] = best_speaker

        except Exception as e:
            diarization_error = str(e)

    emit("transcription_complete", segment_count=len(result_segments))

    # Emit meta first
    print(json.dumps({
        "type": "meta",
        "duration": result_segments[-1]["end"] if result_segments else 0,
        "diarizationRequested": args.speakers != "0",
        "diarizationApplied": diarization_error is None and args.speakers != "0",
        "diarizationError": diarization_error
    }), flush=True)

    # Emit live preview lines with correct speakers
    for seg in result_segments:
        print(json.dumps({
            "type": "segment",
            "start": seg["start"],
            "end": seg["end"],
            "text": seg["text"],
            "speaker": seg["speaker"]
        }), flush=True)

    # Cleanup
    try:
        os.remove(temp_wav)
    except Exception:
        pass

    print(json.dumps({
        "type": "result",
        "segments": result_segments,
        "meta": {
            "duration": result_segments[-1].get("end", 0) if len(result_segments) > 0 else 0,
            "language": getattr(info, "language", "unknown"),
            "model": args.model,
            "diarizationRequested": args.speakers != "0",
            "diarizationApplied": diarization_error is None and args.speakers != "0",
            "diarizationError": diarization_error
        }
    }), flush=True)
    sys.exit(0)


if __name__ == "__main__":
    main()
