import sys
import subprocess
import json
import os
import argparse

def install_dependencies():
    packages = ["openai-whisper", "pyannote.audio", "torch", "torchaudio"]
    for package in packages:
        try:
            __import__(package.replace("-", "_").split(".")[0])
        except ImportError:
            print(json.dumps({"status": "installing", "package": package}))
            subprocess.check_call([sys.executable, "-m", "pip", "install", package],
                                  stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)

def bootstrap(models_dir):
    try:
        install_dependencies()

        import whisper
        import torch

        print(json.dumps({"status": "downloading_model", "model": "base.en"}))
        # This downloads to the default cache, or we can set the cache dir if we want
        whisper.load_model("base.en", download_root=models_dir, device="cpu")

        print(json.dumps({"status": "success"}))
    except Exception as e:
        print(json.dumps({"status": "error", "message": str(e)}))
        sys.exit(1)

if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--models-dir", required=True)
    args = parser.parse_args()
    bootstrap(args.models_dir)
