#!/usr/bin/env python3
"""
Bootstrap script for local-transcriber Obsidian plugin.
Installs required packages and downloads Whisper + pyannote models.
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
        capture_output=True,
        text=True
    )
    if result.returncode != 0:
        print(f"pip install failed for {package}:\n{result.stderr}", file=sys.stderr)
        sys.exit(2)

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--models-dir", required=True, help="Directory to store models")
    args = parser.parse_args()

    models_dir = args.models_dir
    os.makedirs(models_dir, exist_ok=True)

    # Install torch first (special index URL)
    emit({"status": "installing", "package": "torch (CPU)"})
    result = subprocess.run(
        [
            sys.executable, "-m", "pip", "install", "-q",
            "torch", "torchaudio",
            "--index-url", "https://download.pytorch.org/whl/cpu"
        ],
        capture_output=True, text=True
    )
    if result.returncode != 0:
        print(f"Failed to install torch:\n{result.stderr}", file=sys.stderr)
        sys.exit(2)

    # Install remaining packages
    for pkg in ["openai-whisper", "pyannote.audio", "ffmpeg-python"]:
        pip_install(pkg)

    # Download Whisper base model
    emit({"status": "downloading_model", "model": "whisper base.en"})
    try:
        import whisper
        whisper.load_model("base.en", download_root=models_dir)
    except Exception as e:
        print(f"Failed to download whisper model: {e}", file=sys.stderr)
        sys.exit(2)

    emit({"status": "done"})
    sys.exit(0)

if __name__ == "__main__":
    main()
