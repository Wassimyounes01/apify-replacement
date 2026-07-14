#!/usr/bin/env node
'use strict';

/**
 * scrapers/yt-comments.cjs — YouTube comments + video metadata. Apify-free.
 *
 * Covers Apify actors:
 *   - youtube-comments-scraper
 *   - youtube-channel-videos-scraper
 *
 * Uses YouTube Data API v3 (free, 10k units/day quota).
 *   commentThreads.list = 1 unit
 *   channels.list      = 1 unit
 *   playlistItems.list = 1 unit
 *
 * Get a key at: console.cloud.google.com → APIs & Services → YouTube Data API v3
 *
 * Usage:
 *   node scrapers/yt-comments.cjs --video <videoId> [--max 100]
 *   node scrapers/yt-comments.cjs --channel <channelId> [--video-limit 10]
 *   node scrapers/yt-comments.cjs --batch <videos.txt>
 */

const fs = require('fs');
const path = require('path');
const https = require('https');
const { saveJSON, loadEnv, log, DATA_DIR } = require('../lib/browser.cjs');
loadEnv();

const API_KEY = process.env.YOUTUBE_API_KEY || '';
const OUT_DIR = path.join(DATA_DIR, 'yt');
const HISTORY = path.join(DATA_DIR, 'yt-history.jsonl');

const arg = (n, d) => { const i = process.argv.indexOf(n); return i === -1 ? d : process.argv[i + 1]; };

const MODE = arg('--video') ? 'video' : arg('--channel') ? 'channel' : arg('--batch') ? 'batch' : null;
const TARGET = arg('--video') || arg('--channel') || arg('--batch');
const MAX = parseInt(arg('--max', '100'), 10);
const VIDEO_LIMIT = parseInt(arg('--video-limit', '10'), 10);

function get(url) {
  return new Promise((resolve, reject) => {
    https.get(url, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(data) }); }
        catch (e) { reject(new Error(`parse error: ${e.message} (status ${res.statusCode})`)); }
      });
    }).on('error', reject);
  });
}

async function fetchCommentThreads(videoId, max = 100) {
  if (!API_KEY) throw new Error('YOUTUBE_API_KEY not set');
  const out = [];
  let pageToken = '';
  while (out.length < max) {
    const url = `https://www.googleapis.com/youtube/v3/commentThreads?part=snippet,replies&videoId=${encodeURIComponent(videoId)}&maxResults=100&order=time${pageToken ? `&pageToken=${pageToken}` : ''}&key=${API_KEY}`;
    const r = await get(url);
    if (r.status !== 200) {
      throw new Error(`YouTube API ${r.status}: ${r.body?.error?.message || JSON.stringify(r.body).slice(0, 300)}`);
    }
    for (const item of r.body.items || []) {
      const top = item.snippet?.topLevelComment?.snippet || {};
      out.push({
        comment_id: item.id,
        author: top.authorDisplayName,
        author_channel: top.authorChannelId?.value,
        text: top.textDisplay,
        likes: top.likeCount,
        published_at: top.publishedAt,
        updated_at: top.updatedAt,
        reply_count: item.snippet?.totalReplyCount || 0,
        replies: (item.replies?.comments || []).map(rep => ({
          comment_id: rep.id,
          author: rep.snippet?.authorDisplayName,
          text: rep.snippet?.textDisplay,
          likes: rep.snippet?.likeCount,
          published_at: rep.snippet?.publishedAt,
        })),
      });
      if (out.length >= max) break;
    }
    pageToken = r.body.nextPageToken;
    if (!pageToken) break;
  }
  return out;
}

async function fetchChannelVideos(channelId, limit = 10) {
  if (!API_KEY) throw new Error('YOUTUBE_API_KEY not set');
  const ch = await get(`https://www.googleapis.com/youtube/v3/channels?part=contentDetails&id=${encodeURIComponent(channelId)}&key=${API_KEY}`);
  const uploads = ch.body?.items?.[0]?.contentDetails?.relatedPlaylists?.uploads;
  if (!uploads) throw new Error(`No uploads playlist for channel ${channelId}`);
  const pl = await get(`https://www.googleapis.com/youtube/v3/playlistItems?part=snippet,contentDetails&playlistId=${encodeURIComponent(uploads)}&maxResults=${Math.min(limit, 50)}&key=${API_KEY}`);
  return (pl.body?.items || []).map(it => ({
    video_id: it.contentDetails?.videoId,
    title: it.snippet?.title,
    published_at: it.snippet?.publishedAt,
    description: it.snippet?.description?.slice(0, 500),
  }));
}

function saveResult(mode, target, data) {
  const ts = Date.now();
  const file = path.join(OUT_DIR, `${mode}-${String(target).replace(/[^a-z0-9_-]/gi, '_')}-${ts}.json`);
  saveJSON(file, data);
  try { fs.appendFileSync(HISTORY, JSON.stringify({ ts, mode, target, ok: !!data, file }) + '\n'); } catch (_) {}
  return file;
}

async function main() {
  if (!MODE) {
    log.error('usage: --video <id> | --channel <id> | --batch <file>');
    process.exit(2);
  }
  if (!API_KEY) {
    log.error('YOUTUBE_API_KEY not set. See .env.example.');
    process.exit(2);
  }
  if (MODE === 'video') {
    const comments = await fetchCommentThreads(TARGET, MAX);
    log.info(`video ${TARGET}: ${comments.length} threads → ${saveResult('video', TARGET, { video_id: TARGET, count: comments.length, comments, scraped_at: Date.now() })}`);
  } else if (MODE === 'channel') {
    const videos = await fetchChannelVideos(TARGET, VIDEO_LIMIT);
    const results = [];
    for (const v of videos) {
      try {
        const comments = await fetchCommentThreads(v.video_id, MAX);
        results.push({ ...v, comment_count: comments.length, comments });
        log.info(`  ${v.video_id}: ${comments.length} threads`);
      } catch (e) {
        results.push({ ...v, error: e.message });
      }
    }
    log.info(`channel ${TARGET}: ${results.length} videos → ${saveResult('channel', TARGET, { channel_id: TARGET, videos: results, scraped_at: Date.now() })}`);
  } else if (MODE === 'batch') {
    const ids = fs.readFileSync(TARGET, 'utf8').split(/\r?\n/).map(s => s.trim()).filter(s => s && !s.startsWith('#'));
    const results = [];
    for (const id of ids) {
      try { results.push({ video_id: id, comments: await fetchCommentThreads(id, MAX) }); }
      catch (e) { results.push({ video_id: id, error: e.message }); }
    }
    log.info(`batch ${ids.length} videos → ${saveResult('batch', path.basename(TARGET, path.extname(TARGET)), { videos: results, scraped_at: Date.now() })}`);
  }
}

if (require.main === module) {
  main().catch(e => { log.error(`fatal: ${e.message}`); process.exit(1); });
}

module.exports = { fetchCommentThreads, fetchChannelVideos };
