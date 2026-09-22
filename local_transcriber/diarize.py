#!/usr/bin/env python3
import sys
import json
import argparse
from pyannote.audio import Pipeline

def main():
    print("[diarize] Starting diarization", flush=True)
    sys.stdout.flush()
    parser = argparse.ArgumentParser()
    parser.add_argument("--audio-path", required=True)
    parser.add_argument("--expected-speakers", type=int)
    parser.add_argument("--min-speakers", type=int)
    parser.add_argument("--max-speakers", type=int)
    parser.add_argument("--hf-token", default=None)
    args = parser.parse_args()

    print(f"[diarize] Args: audio={args.audio_path}, expected_speakers={args.expected_speakers}", flush=True)

    try:
        print("[diarize] Loading pyannote model...", flush=True)
        pipeline = Pipeline.from_pretrained(
            "pyannote/speaker-diarization-3.1",
            use_auth_token=args.hf_token if args.hf_token else False
        )
        print("[diarize] PyAnnote model loaded", flush=True)

        kwargs = {}
        if args.expected_speakers is not None:
            kwargs["num_speakers"] = args.expected_speakers
        else:
            if args.min_speakers is not None:
                kwargs["min_speakers"] = args.min_speakers
            if args.max_speakers is not None:
                kwargs["max_speakers"] = args.max_speakers

        print(f"[diarize] Running diarization with kwargs: {kwargs}", flush=True)

        diarization = pipeline(args.audio_path, **kwargs)

        print("[diarize] Diarization complete, formatting segments", flush=True)

        segments = []
        for turn, _, speaker in diarization.itertracks(yield_label=True):
            segments.append({
                "start": turn.start,
                "end": turn.end,
                "speaker": speaker
            })

        print(json.dumps({"segments": segments}))

    except Exception as e:
        print(f"[diarize] Error: {e}", flush=True)
        print(f"Error: {e}", file=sys.stderr, flush=True)
        sys.exit(1)

if __name__ == "__main__":
    main()
