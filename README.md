# Local Transcriber — Obsidian Plugin

**Local Transcriber** is a desktop-only Obsidian plugin for **local** transcription.
It supports both:

- **File transcription** (audio/video files → SRT/TXT/Markdown outputs in your vault)
- **Live dictation** (microphone → streaming-ish chunk transcription → text inserted into your note)

All transcription is performed locally via **OpenAI Whisper** running on your machine (Python), and media decoding is handled by **FFmpeg**.

---

## Features

### File transcription

- 🔊 **Right-click transcription** — Right-click any supported audio/video file in the Obsidian file explorer and select **🔊 Transcribe with Whisper**.
- 🖥️ **Command palette transcription** — Transcribe the **current** file or an **external** file via the command palette.
- 🎬 **Audio/video support** — MP3, WAV, M4A, OGG, MP4, MKV, AVI, MOV, WEBM.
- 📄 **SRT / TXT / Both / Markdown-only** — Save subtitles (SRT), plain text (TXT with timestamps), both, or Markdown-only.
- 📝 **Markdown note output** — Optionally create a Markdown note containing an embedded output file plus an inline transcript.
- 🎙️ **Speaker diarization (optional)** — Optionally label speakers using `pyannote.audio` (Speaker 1, Speaker 2, …).

### Live dictation (live speech-to-text)

- 🎙️ **Microphone dictation** — Start a live transcription session from the command palette.
- ⏱️ **Chunked transcription with overlap** — Audio is captured via Web Audio APIs and transcribed in small overlapping chunks for low latency.
- 📝 **Insert at cursor** — Recognized text is inserted directly into the active Markdown editor at the current cursor position.
- 📊 **Dictation modal** — Includes microphone selection, input level meter, and recorded/transcribed progress.
- ✅ **Environment diagnostics** — A command checks Python imports, microphone permission, output folder permissions, and FFmpeg.

---

## Requirements

| Requirement | Notes |
|---|---|
| Obsidian | Desktop only (`isDesktopOnly: true`) |
| Python | 3.10+ (Windows can auto-install via `winget`) |
| FFmpeg | Required for media decoding / conversion (Windows can auto-install via `winget`) |
| Microphone permission | Required for **live dictation** |
| Disk space | ~650MB+ depending on Whisper/pyannote models |

**macOS / Linux users:** Auto-install is not available. Install Python 3.10+, FFmpeg, and set **Python Path Override** in plugin settings before first use.

---

## Installation

1. Download the latest release (`main.js`, `manifest.json`, `styles.css`).
2. Copy the files into `.obsidian/plugins/local-transcriber/` inside your vault.
3. Restart Obsidian.
4. Enable the plugin in **Settings → Community plugins**.
5. Open **Settings → Local Transcriber** and review defaults.

---

## First run / environment setup

On the first transcription attempt (file or live), the plugin will:

1. **Check for Python** — runs `python --version` / `python3 --version`.
2. **Check for FFmpeg** — runs `ffmpeg -version`.
3. **Auto-install (Windows only)** (if enabled):
   - Python 3.12 via `winget install Python.Python.3.12`
   - FFmpeg via `winget install "FFmpeg (Essentials Build)"`
4. **Bootstrap Python packages/models** — installs required packages and downloads models.

This is a one-time process; the plugin stores `envReady` and `modelsReady` in `data.json`.

---

## How to use

### File transcription (vault file)

1. Right-click an audio/video file in the **Files** panel.
2. Select **🔊 Transcribe with Whisper**.
3. Choose model/speaker settings in the modal and start.
4. Output files appear in your configured **Audio Output Folder**.

### File transcription (external file)

1. Open the **Command Palette** (`Ctrl/Cmd + P`).
2. Run **Local Transcriber: Transcribe external file**.
3. Pick any audio/video file.

### File transcription (current file)

1. Open the **Command Palette**.
2. Run **Local Transcriber: Transcribe current file**.

### Live dictation (live speech-to-text)

1. Open a Markdown note and place your cursor where you want text to be inserted.
2. Open the **Command Palette**.
3. Run **Local Transcriber: Start live transcription**.
4. Pick a microphone in the dictation modal, then click **Start**.
5. Speak — text will be inserted into your note.
6. Run **Local Transcriber: Stop live transcription** when done.

Optional: run **Local Transcriber: Check live transcription environment** if dictation fails (permissions/imports/FFmpeg).

---

## Settings

Defaults below are the current defaults from `DEFAULT_SETTINGS` on `master`.

### File transcription

| Setting | Default | Description |
|---|---:|---|
| Model Size | `base.en` | Default Whisper model for file transcription (values come from **Available Models**) |
| Available Models | `tiny.en`, `base.en`, `small.en` | One model per line; used for the model dropdown |
| Models Folder | _(empty)_ | Absolute path to a directory containing Whisper models (optional) |
| Language | `en` | Language code; use `auto` if you need detection |
| Speakers (Default) | `0` | `0` disables diarization; `auto`, `2`, `3`, `4`, `6` supported |
| Output Format | `SRT` | `SRT`, `TXT`, `Both`, or `MD` (Markdown-only) |
| Audio Output Folder | `Audio/` | Folder where SRT/TXT/MD files are saved |
| Create Markdown Note | On | Auto-create a `.md` note with an embedded transcript (hidden when Output Format is `MD`) |
| Markdown Paragraph Interval | `5` | Minutes; set `0` for one line per segment |
| Natural Pause Threshold (seconds) | `1.5` | Silence duration that triggers paragraph breaks |

### Environment

| Setting | Default | Description |
|---|---:|---|
| Python Path Override | _(empty)_ | Path to python executable (often required on macOS/Linux) |
| Auto-Install on Windows | On | Attempt to install Python/FFmpeg automatically on Windows |

### Live dictation

| Setting | Default | Description |
|---|---:|---|
| Live Chunk Seconds | `3` | Length of mic-audio chunks for live transcription |
| Live Chunk Overlap Seconds | `1` | Overlap between chunks to preserve boundary words |
| Live Dictation Language | `en` | Language for dictation |
| Live Model Size | `tiny.en` | Model used for dictation (smaller models recommended for latency) |
| Live Output Folder | `Live_Transcripts/` | Where raw session audio (optional) is saved |
| Save Raw Session Audio | On | Save a full-session WAV file for later reprocessing |
| Live Diarization Strategy | `finalize` | `off`, `live`, or `finalize` (note: current dictation UX disables diarization during chunking) |
| Microphone Device | `default` | Selected microphone device ID |
| Silence Gate (dB) | `-40` | Chunks below this threshold are skipped |

---

## Output behavior

### File transcription outputs

For a source file named `Meeting-2026-03-22.mp4`, the plugin can create:

```
Audio/
  Meeting-2026-03-22.srt
  Meeting-2026-03-22.txt
  Meeting-2026-03-22.md
```

### Live dictation outputs

- Primary output is **inserted text** at the cursor in the active editor.
- If **Save Raw Session Audio** is enabled, the plugin can save a session WAV to:
  `Live_Transcripts/<session-id>.wav`

---

## Technical architecture (high level)

### File transcription flow

```
Right-click menu / Command palette
         ↓
Environment.setupWhisperEnvironment()
  ├── Python/FFmpeg checks (+ optional Windows winget install)
  └── bootstrap.py → pip install + model download
         ↓
transcribe.py (Python)
  ├── ffmpeg → 16kHz mono WAV
  ├── whisper.transcribe()
  └── optional pyannote diarization
         ↓
OutputWriters.saveOutputs()
  ├── SRT/TXT generation
  └── optional Markdown note
```

### Live dictation flow

```
Command: Start live transcription
         ↓
Web Audio (getUserMedia + AudioContext)
         ↓
Chunking (liveChunkSeconds + overlap)
         ↓
transcribe_live.py (Python) per chunk
         ↓
Deduplication / overlap handling
         ↓
Insert text into active editor at cursor
```

---

## Python backend

The plugin ships a `local_transcriber/` Python package inside the plugin folder:

- `bootstrap.py` — Installs packages and downloads models on first run.
- `transcribe.py` — File transcription (Whisper + optional diarization).
- `transcribe_live.py` — Live dictation chunk transcription. Emits JSON events (`meta`, `segment`, `result`).

---

## Troubleshooting

| Problem | Solution |
|---|---|
| “Python is required” | Install Python 3.10+ and add to PATH, or set **Python Path Override** |
| “FFmpeg is required” | Install FFmpeg and add to PATH |
| Live dictation inserts nothing | Ensure a Markdown note is active and the cursor is placed in an editor |
| Live dictation fails to start | Grant microphone permission; try **Check live transcription environment** |
| Chunk transcription seems duplicated | Reduce overlap, or use a larger chunk size; overlap is deduplicated but may still repeat in edge cases |
| macOS/Linux: command not found | Set Python Path Override to your full python path (e.g. `/usr/local/bin/python3`) |

---

## Known limitations

- Desktop only (Obsidian mobile not supported).
- Auto-install is Windows-only.
- Speaker diarization depends on `pyannote.audio` and may require additional model download/auth in some setups.
- Live dictation is chunk-based (near-real-time), not true streaming inference.

---

## License

MIT