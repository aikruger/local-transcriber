#!/usr/bin/env python3
"""
Persistent Whisper model server for live transcription.

Protocol:
  - Reads newline-delimited JSON requests from stdin.
  - Writes newline-delimited JSON responses to stdout.
  - Stays alive until it receives {"type":"shutdown"} or stdin closes.

Request format:
  {"type": "transcribe", "chunkPath": "/abs/path/chunk-00001.wav",
   "chunkStart": 5.0, "sessionId": "live-2026-05-30T14-00-00"}

Response format (one or more lines per request):
  {"type": "meta",    "chunk": "chunk-00001.wav", "chunkStart": 5.0, "duration": 5.0}
  {"type": "segment", "start": 5.21, "end": 7.43, "text": "Hello world.", "speaker": null}
  {"type": "result",  "chunk": "chunk-00001.wav", "segmentCount": 1, "segments": [...]}
  {"type": "error",   "chunk": "chunk-00001.wav", "error": "reason"}
"""

import sys
import os
import json
import argparse
import tempfile
import subprocess


def emit(data: dict):
    """Write a single JSON line to stdout and flush immediately."""
    print(json.dumps(data), flush=True)


def ffmpeg_normalize(input_path: str) -> tuple[str, bool]:
    """
    Convert any audio file to 16 kHz mono WAV using FFmpeg.
    Returns (path_to_wav, is_temp).
    If the file is already a 16 kHz mono WAV we still re-encode
    to be safe, because MediaRecorder sometimes writes malformed headers.
    """
    tmp = tempfile.mktemp(suffix=".wav")
    try:
        subprocess.run(
            ["ffmpeg", "-y", "-i", input_path,
             "-ac", "1", "-ar", "16000", "-vn", tmp],
            check=True,
            capture_output=True
        )
        return tmp, True
    except subprocess.CalledProcessError as e:
        raise RuntimeError(f"ffmpeg failed: {e.stderr.decode(errors='replace')}")


def transcribe_chunk(model, chunk_path: str, chunk_start: float, language):
    """
    Run model.transcribe() on one chunk WAV.
    Emits meta → segments → result.
    Returns list of segment dicts on success, raises on failure.
    """
    chunk_filename = os.path.basename(chunk_path)
    target_wav, is_temp = ffmpeg_normalize(chunk_path)

    try:
        segments_iter, _info = model.transcribe(
            target_wav,
            language=language,
            vad_filter=True,
            vad_parameters={"min_silence_duration_ms": 300},
            word_timestamps=False,
            beam_size=3,
            initial_prompt="",
            temperature=0.0,
            condition_on_previous_text=False
        )
        raw_segments = list(segments_iter)
    finally:
        if is_temp:
            try:
                os.remove(target_wav)
            except Exception:
                pass

    duration = raw_segments[-1].end if raw_segments else 0.0

    emit({
        "type": "meta",
        "chunk": chunk_filename,
        "chunkStart": chunk_start,
        "duration": duration
    })

    segments = []
    for seg in raw_segments:
        text = seg.text.strip()
        if not text:
            continue
        entry = {
            "type": "segment",
            "start": round(seg.start + chunk_start, 3),
            "end":   round(seg.end   + chunk_start, 3),
            "text":  text,
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

    return segments


def main():
    parser = argparse.ArgumentParser(description="Persistent Whisper live transcription server")
    parser.add_argument("--model",      default="tiny",
                        help="Faster-Whisper model name (tiny, base, small, …)")
    parser.add_argument("--language",   default="en",
                        help="Language code, or 'auto' for detection")
    parser.add_argument("--models-dir", default=None,
                        help="Directory where model files are cached")
    parser.add_argument("--device",     default="cpu",
                        choices=["cpu", "cuda", "auto"])
    parser.add_argument("--compute-type", default="int8",
                        help="Quantisation type (int8 recommended for CPU)")
    args = parser.parse_args()

    language = None if args.language in ("auto", "") else args.language

    # ── Load model ONCE ────────────────────────────────────────────────────────
    try:
        from faster_whisper import WhisperModel
        model = WhisperModel(
            args.model,
            device=args.device,
            compute_type=args.compute_type,
            download_root=args.models_dir
        )
        emit({"type": "ready", "model": args.model, "device": args.device})
    except Exception as e:
        emit({"type": "error", "error": f"Model load failed: {str(e)}"})
        sys.exit(1)

    # ── Main request loop ──────────────────────────────────────────────────────
    for raw_line in sys.stdin:
        raw_line = raw_line.strip()
        if not raw_line:
            continue

        try:
            request = json.loads(raw_line)
        except json.JSONDecodeError as e:
            emit({"type": "error", "error": f"Invalid JSON: {e}"})
            continue

        req_type = request.get("type", "")

        if req_type == "shutdown":
            emit({"type": "shutdown_ack"})
            break

        elif req_type == "transcribe":
            chunk_path  = request.get("chunkPath", "")
            chunk_start = float(request.get("chunkStart", 0.0))

            if not chunk_path or not os.path.exists(chunk_path):
                emit({"type": "error",
                      "chunk": os.path.basename(chunk_path),
                      "error": f"File not found: {chunk_path}"})
                continue

            try:
                transcribe_chunk(model, chunk_path, chunk_start, language)
            except Exception as e:
                emit({"type": "error",
                      "chunk": os.path.basename(chunk_path),
                      "error": str(e)})

        else:
            emit({"type": "error", "error": f"Unknown request type: {req_type!r}"})

    # stdin closed or shutdown received — process exits cleanly
    sys.exit(0)


if __name__ == "__main__":
    main()
