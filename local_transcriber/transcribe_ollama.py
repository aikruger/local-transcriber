#!/usr/bin/env python3
"""
Ollama Transcription script for local-transcriber plugin.
Attempts to transcribe audio by sending base64-encoded data to a multimodal Ollama model.
"""

import sys
import os
import json
import argparse
import base64
import urllib.request
import urllib.error
import tempfile
import subprocess

def emit(data: dict):
    data["backend"] = "ollama"
    print(json.dumps(data), flush=True)

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--input", required=True)
    parser.add_argument("--model", required=True)
    args = parser.parse_args()

    emit({"type": "meta", "model": args.model})

    try:
        # We need to make sure the audio is in a format the model can process,
        # typically this means reading the binary data and base64 encoding it.
        # But wait, does Ollama's API officially support audio? Not officially,
        # but models like karanchopda333/whisper might accept base64 in the images array
        # or as a specific prompt format. Let's try to send it in the images array.

        # First, ensure it's a normalized wav or the original format, let's just encode the input file.
        with open(args.input, "rb") as f:
            audio_b64 = base64.b64encode(f.read()).decode('utf-8')

        url = "http://localhost:11434/api/generate"
        payload = {
            "model": args.model,
            "prompt": "Transcribe the following audio.",
            "images": [audio_b64],
            "stream": False
        }

        req = urllib.request.Request(url, data=json.dumps(payload).encode('utf-8'), headers={'Content-Type': 'application/json'})
        response = urllib.request.urlopen(req)
        result = json.loads(response.read().decode('utf-8'))

        text = result.get('response', '').strip()

        # We don't have accurate timestamps from standard Ollama API unless the model provides it in the text.
        # For this v1 implementation, we just return a single segment.
        segment = {
            "type": "segment",
            "start": 0.0,
            "end": 0.0, # We lack duration info, ideally we'd use ffprobe
            "text": text,
            "speaker": None
        }
        emit(segment)

        emit({
            "type": "result",
            "segmentCount": 1,
            "segments": [segment]
        })

        sys.exit(0)
    except Exception as e:
        emit({"type": "error", "error": f"Ollama transcription failed: {str(e)}. Make sure the model supports audio inputs."})
        sys.exit(2)

if __name__ == "__main__":
    main()
