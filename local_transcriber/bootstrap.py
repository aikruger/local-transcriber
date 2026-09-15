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
    args = parser.parse_args()

    models_dir = args.models_dir
    os.makedirs(models_dir, exist_ok=True)

    # faster-whisper uses CTranslate2, no PyTorch required
    for pkg in ["faster-whisper", "pyannote.audio", "ffmpeg-python"]:
        pip_install(pkg)

    # Pre-download tiny (live default) and base (quality option)
    emit({"status": "downloading_model", "model": "faster-whisper tiny"})
    try:
        from faster_whisper import WhisperModel
        WhisperModel("tiny", device="cpu", compute_type="int8",
                     download_root=models_dir)
    except Exception as e:
        print(f"Failed to download tiny model: {e}", file=sys.stderr)
        sys.exit(2)

    emit({"status": "downloading_model", "model": "faster-whisper base"})
    try:
        from faster_whisper import WhisperModel
        WhisperModel("base", device="cpu", compute_type="int8",
                     download_root=models_dir)
    except Exception as e:
        print(f"Failed to download base model: {e}", file=sys.stderr)
        sys.exit(2)

    emit({"status": "done", "python_executable": sys.executable})
    print(f"[bootstrap] Using Python executable: {sys.executable}", file=sys.stderr, flush=True)
    sys.exit(0)

if __name__ == "__main__":
    main()
