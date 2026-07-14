#!/usr/bin/env node
'use strict';

/**
 * scrapers/tiktok-scraper.cjs — TikTok scraper. Apify-free.
 *
 * Covers Apify actors:
 *   - tiktok-scraper (profile + hashtag)
 *   - tiktok-trends-scraper
 *
 * Strategy: TikTok renders JSON in <script id="__UNIVERSAL_DATA_FOR_REHYDRATION__">
 * on both profile and hashtag pages. We parse that.
 *
 * Usage:
 *   node scrapers/tiktok-scraper.cjs --profile <handle>
 *   node scrapers/tiktok-scraper.cjs --hashtag <tag> [--limit 30]
 *   node scrapers/tiktok-scraper.cjs --trending
 */

const fs = require('fs');
const path = require('path');
const { withBrowser, openPage, withRateLimit, saveCookies, saveJSON, loadEnv, log, DATA_DIR } = require('../lib/browser.cjs');
loadEnv();

const OUT_DIR = path.join(DATA_DIR, 'tiktok');
const HISTORY = path.join(DATA_DIR, 'tiktok-history.jsonl');

const arg = (n, d) => { const i = process.argv.indexOf(n); return i === -1 ? d : process.argv[i + 1]; };
const flag = (n) => process.argv.includes(n);

const MODE = arg('--profile') ? 'profile'
  : arg('--hashtag') ? 'hashtag'
  : flag('--trending') ? 'trending'
  : null;
const TARGET = arg('--profile') || arg('--hashtag') || 'trending';
const LIMIT = parseInt(arg('--limit', '20'), 10);

async function extractUniversalData(page) {
  return page.evaluate(() => {
    const tag = document.querySelector('script#__UNIVERSAL_DATA_FOR_REHYDRATION__');
    if (!tag) return null;
    try { return JSON.parse(tag.textContent); } catch (_) { return null; }
  });
}

async function scrapeProfile(browser, handle) {
  const cleaned = handle.replace(/^@/, '');
  const url = `https://www.tiktok.com/@${encodeURIComponent(cleaned)}`;
  return withRateLimit('tiktok.com', async () => {
    const page = await openPage(browser, 'tiktok');
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await new Promise(r => setTimeout(r, 3000));
    await saveCookies(page, 'tiktok');

    const data = await extractUniversalData(page);
    const out = { handle: cleaned, url, scraped_at: Date.now() };
    if (data) {
      try {
        const scope = data?.__DEFAULT_SCOPE__ || {};
        const user = scope['webapp.user-detail']?.userInfo?.user || null;
        const stats = scope['webapp.user-detail']?.userInfo?.stats || null;
        const items = scope['webapp.user-detail']?.userInfo?.itemList || [];
        out.user = user ? {
          unique_id: user.uniqueId,
          nickname: user.nickname,
          bio: user.signature,
          verified: !!user.verified,
          avatar: user.avatarLarger || user.avatarMedium,
          private_account: !!user.privateAccount,
        } : null;
        out.stats = stats ? {
          followers: stats.followerCount,
          following: stats.followingCount,
          hearts: stats.heart || stats.heartCount,
          videos: stats.videoCount,
        } : null;
        out.recent_videos = (items || []).slice(0, 10).map(v => ({
          id: v.id,
          desc: v.desc,
          create_time: v.createTime,
          duration: v.video?.duration,
          plays: v.stats?.playCount,
          likes: v.stats?.diggCount,
          comments: v.stats?.commentCount,
          shares: v.stats?.shareCount,
          cover: v.video?.cover,
        }));
      } catch (_) {}
    }
    await page.close();
    return out;
  });
}

async function scrapeHashtag(browser, tag, limit = 20) {
  const cleaned = tag.replace(/^#/, '').toLowerCase();
  const url = `https://www.tiktok.com/tag/${encodeURIComponent(cleaned)}`;
  return withRateLimit('tiktok.com', async () => {
    const page = await openPage(browser, 'tiktok');
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await new Promise(r => setTimeout(r, 3000));

    const data = await extractUniversalData(page);
    const out = { hashtag: cleaned, url, scraped_at: Date.now(), videos: [] };
    if (data) {
      try {
        const scope = data?.__DEFAULT_SCOPE__ || {};
        const challenge = scope['webapp.challenge-detail']?.challengeInfo?.challenge || null;
        const stats = scope['webapp.challenge-detail']?.challengeInfo?.stats || null;
        const items = scope['webapp.challenge-detail']?.itemList || [];
        out.challenge = challenge ? { id: challenge.id, title: challenge.title, desc: challenge.desc } : null;
        out.stats = stats ? { videos: stats.videoCount, views: stats.viewCount } : null;
        out.videos = items.slice(0, limit).map(v => ({
          id: v.id, desc: v.desc, create_time: v.createTime,
          author: v.author?.uniqueId,
          plays: v.stats?.playCount,
          likes: v.stats?.diggCount,
          comments: v.stats?.commentCount,
          shares: v.stats?.shareCount,
          cover: v.video?.cover,
          music: v.music ? { id: v.music.id, title: v.music.title, author: v.music.authorName } : null,
        }));
      } catch (_) {}
    }
    await page.close();
    return out;
  });
}

async function scrapeTrending(browser) {
  const url = 'https://www.tiktok.com/discover';
  return withRateLimit('tiktok.com', async () => {
    const page = await openPage(browser, 'tiktok');
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await new Promise(r => setTimeout(r, 3000));

    const data = await extractUniversalData(page);
    const out = { url, scraped_at: Date.now(), categories: {} };
    if (data) {
      try {
        out.raw_scope_keys = Object.keys(data?.__DEFAULT_SCOPE__ || {});
        const discover = data?.__DEFAULT_SCOPE__?.['webapp.discover'] || {};
        out.categories.cards = discover?.cardItem || [];
        out.categories.banner = discover?.banner || [];
      } catch (_) {}
    }
    const tags = await page.evaluate(() => {
      const links = Array.from(document.querySelectorAll('a[href^="/tag/"]'));
      return Array.from(new Set(links.map(a => a.getAttribute('href').replace('/tag/', ''))));
    });
    out.visible_trending_tags = tags.slice(0, 30);
    await page.close();
    return out;
  });
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
    log.error('usage: --profile <handle> | --hashtag <tag> | --trending');
    process.exit(2);
  }
  await withBrowser(async (browser) => {
    let data;
    if (MODE === 'profile') data = await scrapeProfile(browser, TARGET);
    else if (MODE === 'hashtag') data = await scrapeHashtag(browser, TARGET, LIMIT);
    else if (MODE === 'trending') data = await scrapeTrending(browser);
    log.info(`${MODE} ${TARGET} → ${saveResult(MODE, TARGET, data)}`);
  });
}

if (require.main === module) {
  main().catch(e => { log.error(`fatal: ${e.message}`); process.exit(1); });
}

module.exports = { scrapeProfile, scrapeHashtag, scrapeTrending };
