#!/usr/bin/env node
'use strict';

/**
 * clipper/yt-transcribe.cjs — transcribe a YouTube video to SRT + JSON.
 *
 * Standalone — just download + transcribe, no clipping. Useful when you
 * only need captions / a transcript.
 *
 * Requires:
 *   - yt-dlp        pip install yt-dlp
 *   - ffmpeg        in PATH
 *   - openai-whisper  pip install openai-whisper  (OR set USE_OPENAI_WHISPER=1 + OPENAI_API_KEY)
 *
 * Usage:
 *   node clipper/yt-transcribe.cjs --url "https://youtube.com/watch?v=..." --output ./out
 *   node clipper/yt-transcribe.cjs --file ./local-video.mp4 --output ./out
 */

const fs = require('fs');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const { loadEnv, log, DATA_DIR } = require('../lib/browser.cjs');
const { downloadVideo, extractAudio, transcribeLocal, transcribeOpenAI, parseSrt } = require('./yt-clipper.cjs');
loadEnv();

const arg = (n, d) => { const i = process.argv.indexOf(n); return i === -1 ? d : process.argv[i + 1]; };

const URL = arg('--url');
const FILE = arg('--file');
const OUTPUT = path.resolve(arg('--output', path.join(DATA_DIR, 'transcripts')));
const WHISPER_MODEL = arg('--whisper-model', 'small');

async function main() {
  if (!URL && !FILE) {
    log.error('usage: --url <youtube-url> | --file <local-video> [--output ./out]');
    process.exit(2);
  }
  fs.mkdirSync(OUTPUT, { recursive: true });

  let videoPath = FILE ? path.resolve(FILE) : await downloadVideo(URL, OUTPUT);
  const audioPath = await extractAudio(videoPath, OUTPUT);

  const useApi = process.env.USE_OPENAI_WHISPER === '1' && process.env.OPENAI_API_KEY;
  const srtPath = useApi
    ? await transcribeOpenAI(audioPath, OUTPUT)
    : await transcribeLocal(audioPath, OUTPUT, WHISPER_MODEL);

  const srtText = fs.readFileSync(srtPath, 'utf8');
  const cues = parseSrt(srtText);

  // Also emit a clean .txt and structured .json
  const plainText = cues.map(c => c.text).join(' ');
  fs.writeFileSync(path.join(OUTPUT, 'transcript.txt'), plainText);
  fs.writeFileSync(path.join(OUTPUT, 'transcript.json'), JSON.stringify({ source: URL || FILE, cues, created_at: Date.now() }, null, 2));

  log.info(`SRT  → ${srtPath}`);
  log.info(`TXT  → ${path.join(OUTPUT, 'transcript.txt')}`);
  log.info(`JSON → ${path.join(OUTPUT, 'transcript.json')}`);
  log.info(`cues: ${cues.length}, words: ~${plainText.split(/\s+/).length}`);
}

if (require.main === module) {
  main().catch(e => { log.error(`fatal: ${e.message}`); process.exit(1); });
}
