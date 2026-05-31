#!/usr/bin/env python3
"""
Bootstrap script for local-transcriber Obsidian plugin.
Installs required packages and downloads faster-whisper models.
Exit codes: 0 = success, 2 = failure.
"""

import sys
import os
import json
import subprocess
import argparse

def emit(obj: dict):
    print(json.dumps(obj), flush=True)

def pip_install(package: str):
    emit({"status": "installing", "package": package})
    result = subprocess.run(
        [sys.executable, "-m", "pip", "install", "-q", package],
        capture_output=True, text=True
    )
    if result.returncode != 0:
        print(f"pip install failed for {package}:\n{result.stderr}", file=sys.stderr)
        sys.exit(2)

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--models-dir", required=True)
    parser.add_argument("--model", default=None, help="Specific model to download")
    args = parser.parse_args()

    models_dir = args.models_dir
    os.makedirs(models_dir, exist_ok=True)

    # faster-whisper uses CTranslate2, no PyTorch required
    for pkg in ["faster-whisper", "pyannote.audio", "ffmpeg-python"]:
        pip_install(pkg)

    # If a specific model is requested, download just that one
    if args.model:
        emit({"status": "downloading_model", "model": args.model})
        try:
            from faster_whisper import WhisperModel
            WhisperModel(args.model, device="cpu", compute_type="int8",
                         download_root=models_dir)
        except Exception as e:
            print(f"Failed to download {args.model} model: {e}", file=sys.stderr)
            sys.exit(2)
    else:
        # Fallback: Pre-download tiny (live default) and base (quality option) if no model specified
        for model in ["tiny", "base"]:
            emit({"status": "downloading_model", "model": model})
            try:
                from faster_whisper import WhisperModel
                WhisperModel(model, device="cpu", compute_type="int8",
                             download_root=models_dir)
            except Exception as e:
                print(f"Failed to download {model} model: {e}", file=sys.stderr)
                sys.exit(2)

    emit({"status": "done"})
    sys.exit(0)

if __name__ == "__main__":
    main()
