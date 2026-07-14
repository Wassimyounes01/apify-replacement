#!/usr/bin/env node
'use strict';

/**
 * clipper/yt-clipper.cjs — YouTube auto-clipper + subtitler.
 *
 * Pipeline:
 *   1. Download YouTube video via yt-dlp
 *   2. Extract audio + transcribe via Whisper → SRT
 *   3. Pick clip segments (even / hooks / script-from-file)
 *   4. For each segment: ffmpeg cut + burn matching SRT slice
 *   5. Output: clip-001.mp4, clip-002.mp4, ... in <output> folder
 *
 * Requires (all free + open source):
 *   - yt-dlp:        pip install yt-dlp        (or scoop install yt-dlp)
 *   - ffmpeg:        in PATH                   (https://ffmpeg.org/download.html)
 *   - openai-whisper:pip install openai-whisper  (default — local, free)
 *
 * Optional cloud fallback (faster but small cost):
 *   - OPENAI_API_KEY set + USE_OPENAI_WHISPER=1 → uses OpenAI Whisper API
 *     (~$0.006/min instead of local CPU compute)
 *
 * Usage:
 *   node clipper/yt-clipper.cjs --url "https://youtube.com/watch?v=..." \
 *                               --clips 6 \
 *                               --duration 30 \
 *                               --output ./out/clips \
 *                               --mode hooks \
 *                               [--keep-source]
 *
 * Modes:
 *   even    — divide video into <clips> equal segments
 *   hooks   — find sentences likely to be "hook" moments (questions, strong verbs)
 *   script  — load clip timestamps from a JSON file: --script timestamps.json
 */

const fs = require('fs');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const { saveJSON, loadEnv, log, DATA_DIR } = require('../lib/browser.cjs');
loadEnv();

const arg = (n, d) => { const i = process.argv.indexOf(n); return i === -1 ? d : process.argv[i + 1]; };
const flag = (n) => process.argv.includes(n);

const URL = arg('--url');
const CLIPS = parseInt(arg('--clips', '6'), 10);
const DURATION = parseInt(arg('--duration', '30'), 10);
const OUTPUT = path.resolve(arg('--output', path.join(DATA_DIR, 'clips')));
const MODE = arg('--mode', 'hooks');
const SCRIPT_FILE = arg('--script');
const WHISPER_MODEL = arg('--whisper-model', 'small');
const KEEP_SOURCE = flag('--keep-source');
const TEMP_DIR = path.join(OUTPUT, '.tmp');

const HOOK_PATTERNS = [
  /\?$/,                                                  // questions
  /\b(here'?s why|the secret|nobody tells you|stop doing|let me show you|wait until|watch this|the truth about)\b/i,
  /\b(I (?:wish|never|just|literally|swear|promise|hate|love))\b/i,
  /\b(this changed|this killed|this saved|this destroyed|this works)\b/i,
  /^(so|but|because|listen|imagine|picture this|what if)\b/i,
];

// ---------- shell ----------
function run(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: opts.silent ? 'pipe' : 'inherit', ...opts });
    let stdout = '', stderr = '';
    if (opts.silent) {
      child.stdout.on('data', d => stdout += d);
      child.stderr.on('data', d => stderr += d);
    }
    child.on('exit', code => code === 0
      ? resolve({ stdout, stderr })
      : reject(new Error(`${cmd} exit ${code}: ${stderr.slice(-500)}`)));
    child.on('error', reject);
  });
}

function which(bin) {
  const r = spawnSync(process.platform === 'win32' ? 'where' : 'which', [bin]);
  return r.status === 0;
}

// ---------- pipeline steps ----------
async function ensureDeps() {
  const missing = [];
  if (!which('yt-dlp')) missing.push('yt-dlp (install: pip install yt-dlp)');
  if (!which('ffmpeg')) missing.push('ffmpeg (install: https://ffmpeg.org)');
  const useApi = process.env.USE_OPENAI_WHISPER === '1' && process.env.OPENAI_API_KEY;
  if (!useApi && !which('whisper')) missing.push('whisper (install: pip install openai-whisper) or set USE_OPENAI_WHISPER=1 + OPENAI_API_KEY');
  if (missing.length) {
    log.error('Missing dependencies:');
    missing.forEach(m => log.error('  - ' + m));
    process.exit(2);
  }
}

async function downloadVideo(url, outDir) {
  fs.mkdirSync(outDir, { recursive: true });
  const out = path.join(outDir, 'source.%(ext)s');
  log.info(`[1/4] downloading: ${url}`);
  await run('yt-dlp', [
    '-f', 'bestvideo[height<=1080]+bestaudio/best[height<=1080]',
    '--merge-output-format', 'mp4',
    '-o', out,
    url,
  ]);
  // Find the resulting file
  const files = fs.readdirSync(outDir).filter(f => f.startsWith('source.'));
  if (!files.length) throw new Error('yt-dlp produced no output');
  return path.join(outDir, files[0]);
}

async function extractAudio(videoPath, outDir) {
  const audioPath = path.join(outDir, 'audio.wav');
  log.info('[2a/4] extracting audio');
  await run('ffmpeg', ['-y', '-i', videoPath, '-vn', '-ar', '16000', '-ac', '1', '-c:a', 'pcm_s16le', audioPath, '-loglevel', 'error']);
  return audioPath;
}

async function transcribeLocal(audioPath, outDir, model = 'small') {
  log.info(`[2b/4] transcribing (local whisper, model=${model})`);
  await run('whisper', [audioPath,
    '--model', model,
    '--output_format', 'srt',
    '--output_dir', outDir,
    '--language', 'en',
    '--verbose', 'False',
  ]);
  const srtPath = path.join(outDir, path.basename(audioPath, path.extname(audioPath)) + '.srt');
  if (!fs.existsSync(srtPath)) throw new Error('whisper did not produce SRT');
  return srtPath;
}

async function transcribeOpenAI(audioPath, outDir) {
  log.info('[2b/4] transcribing (OpenAI API, model=whisper-1)');
  const https = require('https');
  const FormData = (() => {
    // Lightweight multipart builder so we don't add a npm dep
    function boundary() { return '----FormBoundary' + Date.now(); }
    return { boundary };
  })();
  // Use a child process curl to keep this dep-free if curl is present
  if (!which('curl')) throw new Error('OpenAI Whisper fallback needs curl in PATH');
  const srtPath = path.join(outDir, 'audio.srt');
  await run('curl', [
    '-s', '-o', srtPath,
    'https://api.openai.com/v1/audio/transcriptions',
    '-H', `Authorization: Bearer ${process.env.OPENAI_API_KEY}`,
    '-F', `file=@${audioPath}`,
    '-F', 'model=whisper-1',
    '-F', 'response_format=srt',
  ]);
  if (!fs.existsSync(srtPath) || fs.statSync(srtPath).size < 50) {
    throw new Error('OpenAI Whisper API returned empty/invalid SRT');
  }
  return srtPath;
}

function parseSrt(srtText) {
  const blocks = srtText.replace(/\r/g, '').split(/\n\n+/);
  const cues = [];
  for (const b of blocks) {
    const lines = b.split('\n').filter(Boolean);
    if (lines.length < 2) continue;
    const tsLine = lines.find(l => /-->/.test(l));
    if (!tsLine) continue;
    const m = tsLine.match(/(\d{2}):(\d{2}):(\d{2})[,.](\d{3})\s*-->\s*(\d{2}):(\d{2}):(\d{2})[,.](\d{3})/);
    if (!m) continue;
    const start = +m[1]*3600 + +m[2]*60 + +m[3] + +m[4]/1000;
    const end = +m[5]*3600 + +m[6]*60 + +m[7] + +m[8]/1000;
    const text = lines.slice(lines.indexOf(tsLine) + 1).join(' ').trim();
    cues.push({ start, end, text });
  }
  return cues;
}

function getVideoDuration(videoPath) {
  const r = spawnSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', videoPath]);
  return parseFloat(r.stdout.toString().trim());
}

function pickSegments(cues, duration, n, mode, videoDuration, scriptFile) {
  if (mode === 'script' && scriptFile) {
    const data = JSON.parse(fs.readFileSync(scriptFile, 'utf8'));
    return data.segments || data;
  }
  if (mode === 'even' || !cues.length) {
    const step = Math.max((videoDuration - duration) / Math.max(n - 1, 1), 1);
    return Array.from({ length: n }, (_, i) => ({
      start: Math.round(i * step),
      duration,
      label: `segment-${i + 1}`,
    }));
  }
  // hooks mode: find sentences matching hook patterns; pick top N by spread + match score
  const scored = cues.map(c => {
    let score = 0;
    for (const re of HOOK_PATTERNS) if (re.test(c.text)) score += 1;
    return { ...c, score };
  }).filter(c => c.score > 0);
  // Sort by score, then enforce minimum gap so we don't pick adjacent moments
  scored.sort((a, b) => b.score - a.score);
  const picks = [];
  for (const c of scored) {
    if (picks.length >= n) break;
    if (picks.every(p => Math.abs(p.start - c.start) > duration * 1.5)) {
      picks.push({
        start: Math.max(0, c.start - 2),
        duration,
        label: `hook-${picks.length + 1}-${c.text.slice(0, 40).replace(/[^a-z0-9]+/gi, '-').toLowerCase()}`,
      });
    }
  }
  // Fall back to even if hooks underdeliver
  if (picks.length < n) {
    const filler = pickSegments([], duration, n - picks.length, 'even', videoDuration);
    picks.push(...filler);
  }
  return picks.slice(0, n);
}

function srtTime(s) {
  const hh = String(Math.floor(s / 3600)).padStart(2, '0');
  const mm = String(Math.floor((s % 3600) / 60)).padStart(2, '0');
  const ss = String(Math.floor(s % 60)).padStart(2, '0');
  const ms = String(Math.floor((s - Math.floor(s)) * 1000)).padStart(3, '0');
  return `${hh}:${mm}:${ss},${ms}`;
}

function sliceSrt(cues, segStart, segDuration) {
  const segEnd = segStart + segDuration;
  const subset = cues
    .filter(c => c.end > segStart && c.start < segEnd)
    .map((c, i) => {
      const start = Math.max(0, c.start - segStart);
      const end = Math.min(segDuration, c.end - segStart);
      return `${i + 1}\n${srtTime(start)} --> ${srtTime(end)}\n${c.text}\n`;
    });
  return subset.join('\n');
}

async function clipAndBurn(videoPath, srtSlicePath, seg, outFile) {
  // ffmpeg subtitles filter wants forward-slashes even on Windows
  const subPath = srtSlicePath.replace(/\\/g, '/').replace(/^([A-Z]):/i, '$1\\:');
  const style = "FontName=Arial Bold,FontSize=18,PrimaryColour=&H00FFFFFF,OutlineColour=&H00000000,BorderStyle=3,Outline=2,Shadow=1,Alignment=2,MarginV=60";
  await run('ffmpeg', [
    '-y',
    '-ss', String(seg.start),
    '-t', String(seg.duration),
    '-i', videoPath,
    '-vf', `subtitles='${subPath}':force_style='${style}'`,
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23',
    '-c:a', 'aac', '-b:a', '128k',
    outFile,
    '-loglevel', 'error',
  ]);
}

// ---------- main ----------
async function main() {
  if (!URL) {
    log.error('usage: --url <youtube-url> [--clips 6 --duration 30 --output ./clips --mode hooks|even|script]');
    process.exit(2);
  }
  await ensureDeps();
  fs.mkdirSync(OUTPUT, { recursive: true });
  fs.mkdirSync(TEMP_DIR, { recursive: true });

  const videoPath = await downloadVideo(URL, TEMP_DIR);
  const audioPath = await extractAudio(videoPath, TEMP_DIR);
  const useApi = process.env.USE_OPENAI_WHISPER === '1' && process.env.OPENAI_API_KEY;
  const srtPath = useApi
    ? await transcribeOpenAI(audioPath, TEMP_DIR)
    : await transcribeLocal(audioPath, TEMP_DIR, WHISPER_MODEL);

  const srtText = fs.readFileSync(srtPath, 'utf8');
  const cues = parseSrt(srtText);
  const videoDuration = getVideoDuration(videoPath);
  log.info(`[3/4] picking ${CLIPS} segments (mode=${MODE}, video duration=${Math.round(videoDuration)}s)`);
  const segments = pickSegments(cues, DURATION, CLIPS, MODE, videoDuration, SCRIPT_FILE);

  // Save manifest
  saveJSON(path.join(OUTPUT, 'manifest.json'), {
    source: URL,
    video_duration_s: videoDuration,
    mode: MODE,
    clips_count: segments.length,
    segments,
    created_at: Date.now(),
  });

  log.info(`[4/4] cutting + burning ${segments.length} clips`);
  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i];
    const slicePath = path.join(TEMP_DIR, `clip-${String(i + 1).padStart(3, '0')}.srt`);
    fs.writeFileSync(slicePath, sliceSrt(cues, seg.start, seg.duration));
    const outFile = path.join(OUTPUT, `clip-${String(i + 1).padStart(3, '0')}-${seg.label || 'segment'}.mp4`);
    try {
      await clipAndBurn(videoPath, slicePath, seg, outFile);
      log.info(`  ${path.basename(outFile)} (${seg.start}s + ${seg.duration}s)`);
    } catch (e) {
      log.warn(`  FAIL ${path.basename(outFile)}: ${e.message}`);
    }
  }

  if (!KEEP_SOURCE) {
    try { fs.rmSync(TEMP_DIR, { recursive: true, force: true }); } catch (_) {}
  }
  log.info(`done → ${OUTPUT}`);
}

if (require.main === module) {
  main().catch(e => { log.error(`fatal: ${e.message}`); process.exit(1); });
}

module.exports = { downloadVideo, extractAudio, transcribeLocal, transcribeOpenAI, parseSrt, pickSegments, clipAndBurn };
