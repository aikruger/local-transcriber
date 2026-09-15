#!/usr/bin/env python3
import sys
import os
import json
import argparse
import tempfile
import time

def emit(data: dict):
    print(json.dumps(data), flush=True)

def is_hallucination(text: str) -> bool:
    """Detect repetitive hallucinated output."""
    if not text or len(text) < 10:
        return False
    words = text.lower().split()
    if len(words) < 4:
        return False
    # Check if more than 60% of words are the same token
    from collections import Counter
    most_common_count = Counter(words).most_common(1)[0][1]
    if most_common_count / len(words) > 0.6:
        print(f"[whisper_server] Hallucination detected (repetition): {text[:80]}", file=sys.stderr, flush=True)
        return True
    # Check for character-level repetition (D-D-D-D pattern)
    if len(set(text.replace(' ', '').replace('-', ''))) < 3 and len(text) > 10:
        print(f"[whisper_server] Hallucination detected (char repetition): {text[:80]}", file=sys.stderr, flush=True)
        return True
    return False

def transcribe_chunk(model, chunk_path: str, chunk_start: float, language):
    chunk_filename = os.path.basename(chunk_path)
    target_wav = chunk_path
    
    try:
        segments_iter, _info = model.transcribe(
            target_wav,
            language=language,
            vad_filter=True,
            vad_parameters={
                "min_silence_duration_ms": 500,
                "speech_pad_ms": 200,
                "threshold": 0.5,
            },
            word_timestamps=False,
            beam_size=5,
            temperature=0.0,
            condition_on_previous_text=False,
            no_speech_threshold=0.6,
            log_prob_threshold=-1.0,
            compression_ratio_threshold=2.4,
        )
        raw_segments = list(segments_iter)
    except Exception as e:
        raise RuntimeError(f"Whisper transcription failed: {str(e)}")

    print(f"[whisper_server] transcribed chunk: {len(raw_segments)} segments", file=sys.stderr, flush=True)
    duration = raw_segments[-1].end if raw_segments else 0.0

    emit({"type": "meta", "chunk": chunk_filename, "chunkStart": chunk_start, "duration": duration})

    segments = []
    for seg in raw_segments:
        text = seg.text.strip()
        if not text: continue
        if is_hallucination(text):
            continue   # silently drop hallucinated segments
        entry = {
            "type": "segment",
            "start": round(seg.start + chunk_start, 3),
            "end": round(seg.end + chunk_start, 3),
            "text": text,
            "speaker": None
        }
        emit(entry)
        segments.append(entry)

    emit({"type": "result", "chunk": chunk_filename, "segmentCount": len(segments), "segments": segments})
    return segments

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--model", default="tiny")
    parser.add_argument("--language", default="en")
    parser.add_argument("--models-dir", default=None)
    parser.add_argument("--device", default="cpu")
    parser.add_argument("--compute-type", default="int8")
    args = parser.parse_args()

    try:
        from faster_whisper import WhisperModel
        model = WhisperModel(args.model, device=args.device, compute_type=args.compute_type, download_root=args.models_dir)
        emit({"type": "ready", "model": args.model, "device": args.device})
    except Exception as e:
        emit({"type": "error", "error": f"Model load failed: {str(e)}"})
        sys.exit(1)

    for raw_line in sys.stdin:
        line = raw_line.strip()
        if not line: continue
        try:
            req = json.loads(line)
            if req.get("type") == "shutdown": break
            if req.get("type") == "transcribe":
                start_t = time.time()
                transcribe_chunk(model, req["chunkPath"], float(req["chunkStart"]), args.language)
        except Exception as e:
            emit({"type": "error", "error": str(e)})

if __name__ == "__main__":
    main()
