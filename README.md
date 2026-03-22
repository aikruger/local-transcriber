# Local Transcriber — Obsidian Plugin

**Local Transcriber** is a desktop-only Obsidian plugin that transcribes audio and video files
directly within your vault using OpenAI Whisper, running entirely on your own machine.
No data is sent to any external service.

---

## Features

- 🔊 **Right-click transcription** — Right-click any audio/video file in the Obsidian file
  explorer and select "Transcribe with Whisper".
- 🎬 **Audio/video support** — Works with MP3, WAV, M4A, OGG, MP4, MKV, AVI, MOV, WEBM.
- 🤖 **Local Whisper models** — Runs OpenAI Whisper (`tiny.en`, `base.en`, `small.en`)
  locally via Python.
- 🎙️ **Speaker diarization** — Optionally identifies distinct speakers using
  `pyannote.audio` and labels them as Speaker 1, Speaker 2, etc.
- 📄 **SRT, TXT, or both** — Generates timestamped subtitles in SRT format
  and/or plain-text transcripts.
- 📝 **Markdown note** — Optionally creates a linked markdown note with the full
  transcript embedded and timestamped inline.
- ⚙️ **Auto-setup (Windows)** — On first run, automatically installs Python and FFmpeg
  via `winget` if missing, then bootstraps all required Python packages and downloads models.
- 🖥️ **External file transcription** — Transcribe audio/video files that live outside
  your vault via the command palette.

---

## Requirements

| Requirement | Notes |
|---|---|
| Obsidian | Desktop only (`isDesktopOnly: true`) |
| Python | 3.10 or later. Auto-installed on Windows via `winget`. |
| FFmpeg | Required for video → audio extraction. Auto-installed on Windows. |
| ~650 MB disk | For Whisper base model (~142 MB) and pyannote models (~300–500 MB) |

**macOS / Linux users:** Auto-install is not available. Install Python 3.10+, FFmpeg, and
set the Python Path Override in plugin settings before first use.

---

## Installation

1. Download the latest release (`main.js`, `manifest.json`, `styles.css`).
2. Copy all three files into `.obsidian/plugins/local-transcriber/` inside your vault.
3. Restart Obsidian.
4. Enable the plugin in **Settings → Community plugins**.
5. Open **Settings → Local Transcriber** and review defaults.

---

## First Run

On the first transcription attempt, the plugin will:

1. **Check for Python** — runs `python --version` / `python3 --version`.
2. **Check for FFmpeg** — runs `ffmpeg -version`.
3. **Auto-install** (Windows only, if enabled in settings):
   - Installs Python 3.12 via `winget install Python.Python.3.12`.
   - Installs FFmpeg via `winget install "FFmpeg (Essentials Build)"`.
4. **Bootstrap Python packages** — installs `openai-whisper`, `pyannote.audio`,
   `torch`, `torchaudio` (CPU build) via pip.
5. **Download models** — downloads the selected Whisper model and pyannote
   diarization model to `.obsidian/plugins/local-transcriber/models/`.

This is a one-time process. Progress is shown in the Transcribing modal.
After setup completes, `envReady` and `modelsReady` are saved to `data.json`
so setup is skipped on subsequent runs.

---

## How to Use

### Transcribe a file in your vault

1. Right-click any audio/video file in the **Files** panel.
2. Select **🔊 Transcribe with Whisper**.
3. Watch the progress modal — setup runs if needed, then Whisper runs.
4. Output files appear in the configured `Audio/` folder.

### Transcribe an external file

1. Open the **Command Palette** (`Ctrl/Cmd + P`).
2. Run **Local Transcriber: Transcribe external file**.
3. Use the file picker dialog to select any audio/video file on your filesystem.
4. Output is saved to the same `Audio/` folder in your vault.

### Transcribe the currently open file

1. Open the **Command Palette**.
2. Run **Local Transcriber: Transcribe current file**.
3. Only available when the active file is a supported audio/video format.

---

## Settings

| Setting | Default | Description |
|---|---|---|
| Model Size | `base.en` | Whisper model: `tiny.en` (fastest), `base.en`, `small.en` (most accurate) |
| Language | `auto` | Transcription language code (e.g. `en`, `fr`) or `auto` for detection |
| Speakers | `0` | Number of speakers for diarization: `0` = disabled, `2`, `4`, or `auto` |
| Output Format | `SRT` | `SRT`, `TXT`, or `Both` |
| Audio Output Folder | `Audio/` | Vault folder where SRT/TXT/MD files are saved |
| Create Markdown Note | On | Auto-creates a `.md` note with embedded transcript |
| Python Path Override | _(empty)_ | Full path to Python executable. Required on macOS/Linux if not in PATH |
| Auto-Install on Windows | On | Use `winget` to install Python/FFmpeg if missing |

---

## Output Files

For a source file named `Meeting-2026-03-22.mp4`, the plugin creates:

```
Audio/
  Meeting-2026-03-22.srt    ← Timestamped SRT subtitle file
  Meeting-2026-03-22.txt    ← Plain text with timestamps (if TXT/Both selected)
  Meeting-2026-03-22.md     ← Markdown note with embedded transcript
```

**SRT example:**
```
1
00:00:00,120 --> 00:00:02,340
Speaker 1: Hello, welcome to the meeting.

2
00:00:02,500 --> 00:00:05,000
Speaker 2: Thanks for joining.
```

**Markdown note example:**
```markdown
# Transcription: Meeting-2026-03-22

![[Audio/Meeting-2026-03-22.srt]]

***

**[00:00] Speaker 1:** Hello, welcome to the meeting.

**[00:02] Speaker 2:** Thanks for joining.
```

---

## Technical Architecture

```
Right-click menu / Command palette
         ↓
  isMediaFile() check
         ↓
  setupWhisperEnvironment()
    ├── hasPython() / hasFFmpeg()
    ├── installPythonWindows() [Windows only]
    ├── installFFmpegWindows() [Windows only]
    └── bootstrapPython() → pip install + model download
         ↓
  processFile(absolutePath)
    └── spawn(python, [transcribe.py, --input, --model, --speakers, ...])
          ├── ffmpeg: input → 16kHz mono WAV
          ├── whisper.transcribe() → segments with timestamps
          ├── pyannote pipeline → speaker intervals
          └── merge → JSON { segments: [{start, end, text, speaker}] }
         ↓
  saveOutputs(basename, segments)
    ├── SRT generation → Audio/<name>.srt
    ├── TXT generation → Audio/<name>.txt
    └── Markdown note  → Audio/<name>.md
```

---

## Python Backend

The plugin ships a `local_transcriber/` Python package inside the plugin folder:

- `bootstrap.py` — Installs packages and downloads models on first run.
  Emits JSON status lines: `{"status": "installing", "package": "..."}`.
- `transcribe.py` — Runs Whisper + optional pyannote. Accepts CLI args:
  `--input`, `--model`, `--language`, `--speakers`, `--models-dir`.
  Emits a single JSON object on stdout:
  ```json
  {
    "segments": [
      { "start": 0.12, "end": 2.34, "text": "Hello.", "speaker": "SPEAKER_00" }
    ],
    "meta": { "duration": 180.0, "language": "en", "model": "base.en" }
  }
  ```

---

## Troubleshooting

| Problem | Solution |
|---|---|
| "Python is required" | Install Python 3.10+ and add to PATH, or set Python Path Override in settings |
| "FFmpeg is required" | Install FFmpeg and add to PATH |
| Bootstrap fails | Check internet connection; retry by setting `modelsReady: false` in `.obsidian/plugins/local-transcriber/data.json` |
| Transcription hangs | Large files (>30 min) take significant time on CPU. Consider using `tiny.en` model |
| No speakers in output | Speakers setting must be set to `2`, `4`, or `auto` — not `0` |
| macOS/Linux: command not found | Set Python Path Override in settings to your full Python path (e.g. `/usr/local/bin/python3`) |

---

## Vault Organisation (Recommended)

```
Audio/
  Meeting-2026-03-22.srt
  Meeting-2026-03-22.md
Notes/
  2026-03-22-Meeting.md    ← references ![[Audio/Meeting-2026-03-22.srt]]
```

---

## Known Limitations

- Desktop only. Not compatible with Obsidian mobile.
- Auto-install is Windows-only. macOS and Linux require manual setup.
- Speaker diarization requires `pyannote.audio` models (~300 MB) and a
  Hugging Face account token for model download in some configurations.
- GPU acceleration is detected automatically (`torch.cuda` if NVIDIA present);
  CPU-only builds are installed by default.

---

## License

MIT