import argparse
import json
import os
import subprocess
import sys
import tempfile
import time

def process_audio(input_file, temp_dir):
    # If the file is not wav, 16khz, mono, ffmpeg converts it
    output_wav = os.path.join(temp_dir, "temp.wav")
    try:
        subprocess.run([
            "ffmpeg", "-i", input_file,
            "-ac", "1", "-ar", "16000", "-vn", output_wav,
            "-y"
        ], check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        return output_wav
    except subprocess.CalledProcessError as e:
        print(json.dumps({"error": "Failed to extract audio with ffmpeg", "details": str(e)}))
        sys.exit(1)

def transcribe(audio_path, model_size, language, speakers_option, models_dir):
    import torch
    import whisper

    device = "cuda" if torch.cuda.is_available() else "cpu"

    try:
        model = whisper.load_model(model_size, device=device, download_root=models_dir)
    except Exception as e:
        print(json.dumps({"error": "Failed to load whisper model", "details": str(e)}))
        sys.exit(1)

    options = {"word_timestamps": True}
    if language and language.lower() != "auto":
        options["language"] = language

    start_time = time.time()

    try:
        result = model.transcribe(audio_path, **options)
    except Exception as e:
        print(json.dumps({"error": "Transcription failed", "details": str(e)}))
        sys.exit(1)

    segments = result.get("segments", [])
    meta = {
        "duration": time.time() - start_time,
        "language": result.get("language", "auto"),
        "model": model_size
    }

    # We could do diarization here if speakers > 0 or auto
    # To keep dependencies light and code simple for MVP, we might only try diarization if pyannote is available
    if str(speakers_option).lower() not in ["none", "0"]:
        try:
            from pyannote.audio import Pipeline
            # Note: pyannote typically requires an auth token for its models,
            # if we have locally cached weights we can try: use_auth_token=False
            try:
                # We need to set use_auth_token to False or valid token, assuming user has it cached or offline
                pipeline = Pipeline.from_pretrained("pyannote/speaker-diarization-3.1", use_auth_token=False)
                if pipeline:
                    pipeline.to(torch.device(device))
                    diarization = pipeline(audio_path)

                    # Align speakers
                    for segment in segments:
                        segment_start = segment["start"]
                        segment_end = segment["end"]
                        segment_mid = (segment_start + segment_end) / 2

                        # Find the dominant speaker by checking where the midpoint falls
                        # Alternatively, check overlaps
                        speaker_id = None
                        max_overlap = 0.0

                        for turn, _, speaker in diarization.itertracks(yield_label=True):
                            overlap = max(0, min(segment_end, turn.end) - max(segment_start, turn.start))
                            if overlap > max_overlap:
                                max_overlap = overlap
                                speaker_id = speaker

                        if speaker_id:
                            segment["speaker"] = speaker_id
            except Exception as e:
                # Silently fail diarization and just return transcript
                pass
        except ImportError:
            pass

    # Normalize output
    out_segments = []
    for s in segments:
        out_segments.append({
            "start": s.get("start"),
            "end": s.get("end"),
            "text": s.get("text", "").strip(),
            "speaker": s.get("speaker", None)
        })

    print(json.dumps({
        "segments": out_segments,
        "meta": meta
    }))

if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--input", required=True)
    parser.add_argument("--model", default="base.en")
    parser.add_argument("--language", default="en")
    parser.add_argument("--speakers", default="0")
    parser.add_argument("--models-dir", required=True)

    args = parser.parse_args()

    with tempfile.TemporaryDirectory() as temp_dir:
        audio_path = process_audio(args.input, temp_dir)
        transcribe(audio_path, args.model, args.language, args.speakers, args.models_dir)
