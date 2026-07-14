# Clipper — YouTube auto-clipper + transcriber

Take a YouTube video → clip it into short segments → burn subtitles into
each clip → drop all clips into an output folder.

Three modes:
- **hooks** (default) — Whisper transcribes, hook-pattern matcher picks the
  most attention-grabby sentences (questions, "here's why...", "I never...",
  "wait until you...") and centers a clip on each
- **even** — divides the video into N equally-spaced clips
- **script** — you supply a JSON file with exact timestamps

## Requirements (all free, all open source)

Install once on the machine that will run this:

```bash
# yt-dlp (downloads YouTube videos)
pip install yt-dlp

# ffmpeg (video cutting + subtitle burning)
# Windows:  choco install ffmpeg   (or download from ffmpeg.org)
# Mac:      brew install ffmpeg
# Linux:    apt install ffmpeg

# Whisper (local transcription, CPU-friendly)
pip install openai-whisper

# Verify all three work:
yt-dlp --version
ffmpeg -version
whisper --help
```

If local Whisper is too slow on a low-end machine, set the cloud fallback:

```bash
# In .env:
USE_OPENAI_WHISPER=1
OPENAI_API_KEY=sk-...
```

OpenAI's Whisper API costs ~$0.006/min of audio (a 30-min video ≈ $0.18).

## Usage

### Hooks mode (recommended)

```bash
node clipper/yt-clipper.cjs \
  --url "https://www.youtube.com/watch?v=dQw4w9WgXcQ" \
  --clips 6 \
  --duration 30 \
  --output ./out/clips \
  --mode hooks
```

Output:
```
out/clips/
├── manifest.json
├── clip-001-hook-1-stop-doing-this-now.mp4
├── clip-002-hook-2-the-secret-nobody-tells.mp4
├── clip-003-hook-3-i-wish-i-knew-this.mp4
├── clip-004-hook-4-watch-what-happens-next.mp4
├── clip-005-hook-5-the-real-reason.mp4
└── clip-006-hook-6-this-changed-everything.mp4
```

Each clip is a vertical-or-horizontal MP4 (whatever the source was), with
subtitles burned into the bottom of the frame in Arial Bold, white text +
black outline.

### Even mode

Divides the video into 6 equal segments of 30s each:

```bash
node clipper/yt-clipper.cjs --url <url> --clips 6 --duration 30 --mode even --output ./out
```

### Script mode (you decide the timestamps)

```bash
# Create timestamps.json:
# {
#   "segments": [
#     { "start": 12,  "duration": 30, "label": "intro-hook" },
#     { "start": 87,  "duration": 45, "label": "main-point" },
#     { "start": 230, "duration": 20, "label": "punchline" }
#   ]
# }

node clipper/yt-clipper.cjs --url <url> --mode script --script timestamps.json --output ./out
```

## Tuning

| Flag | Default | Notes |
|---|---|---|
| `--clips N` | 6 | Number of clips to produce |
| `--duration S` | 30 | Seconds per clip |
| `--mode` | hooks | hooks / even / script |
| `--whisper-model` | small | tiny / base / small / medium / large-v3 — bigger = more accurate + slower |
| `--keep-source` | off | Keep the downloaded source video + raw SRT after clipping (debug) |

## Transcribe only (no clipping)

If you just want the transcript:

```bash
node clipper/yt-transcribe.cjs --url <url> --output ./out
```

Produces three files in `./out`:
- `audio.srt` — SRT with timestamps
- `transcript.txt` — plain text
- `transcript.json` — structured cues for programmatic use

You can also transcribe a local file:

```bash
node clipper/yt-transcribe.cjs --file /path/to/video.mp4 --output ./out
```

## What replaces Apify here

This replaces typical Apify actors:
- `apify/youtube-video-downloader`
- `apify/audio-extractor`
- `apify/whisper-transcriber`
- `apify/video-clipper`
- `apify/subtitle-burner`

All five steps in one local CLI, free, runs on your own hardware.

## Performance notes

- A 30-min video on a modern laptop: ~3-5 min total (download + small whisper + 6 clip cuts)
- Whisper `small` is the sweet spot: ~5x faster than `large-v3`, ~95% as accurate for English
- ffmpeg cutting + subtitle burning is GPU-accelerated if your ffmpeg build was compiled with `--enable-libx264` and a GPU encoder — most prebuilt Windows ffmpeg's are not. The `libx264` software encoder works on every machine but uses CPU.

## Common errors

| Error | Fix |
|---|---|
| `yt-dlp: command not found` | `pip install yt-dlp`; restart terminal |
| `ffmpeg: command not found` | Install ffmpeg; add to PATH |
| `whisper did not produce SRT` | Audio file is empty (download failed) — check yt-dlp output |
| `OpenAI Whisper fallback needs curl` | Install curl OR fall back to local whisper |
| Clip has no subtitles | The SRT slice for that segment was empty (silence) — check `keep-source` output |
