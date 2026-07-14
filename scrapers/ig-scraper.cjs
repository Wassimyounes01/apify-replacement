#!/usr/bin/env node
'use strict';

/**
 * scrapers/ig-scraper.cjs — Instagram scraper. Apify-free.
 *
 * Covers Apify actors:
 *   - instagram-profile-scraper
 *   - instagram-hashtag-scraper
 *   - instagram-post-scraper (top-N posts from a profile)
 *
 * Strategy: parse window._sharedData embedded JSON from public IG pages.
 * On block (login wall), set USE_BROWSERBASE=1 to route via residential IP.
 *
 * Usage:
 *   node scrapers/ig-scraper.cjs --profile <handle>
 *   node scrapers/ig-scraper.cjs --hashtag <tag> [--limit 30]
 *   node scrapers/ig-scraper.cjs --recent <handle> [--count 10]
 *   node scrapers/ig-scraper.cjs --batch <handles.txt>
 *
 * Output: data/ig/<mode>-<target>-<ts>.json + appends to data/ig-history.jsonl
 */

const fs = require('fs');
const path = require('path');
const { withBrowser, openPage, withRateLimit, saveCookies, safeReadJsonFromPage, saveJSON, loadEnv, log, DATA_DIR } = require('../lib/browser.cjs');
loadEnv();

const OUT_DIR = path.join(DATA_DIR, 'ig');
const HISTORY = path.join(DATA_DIR, 'ig-history.jsonl');

const arg = (n, d) => { const i = process.argv.indexOf(n); return i === -1 ? d : process.argv[i + 1]; };
const flag = (n) => process.argv.includes(n);

const MODE = arg('--profile') ? 'profile'
  : arg('--hashtag') ? 'hashtag'
  : arg('--recent') ? 'recent'
  : arg('--batch') ? 'batch'
  : null;
const TARGET = arg('--profile') || arg('--hashtag') || arg('--recent') || arg('--batch');
const LIMIT = parseInt(arg('--limit', '20'), 10);
const COUNT = parseInt(arg('--count', '10'), 10);

async function scrapeProfile(browser, handle) {
  const url = `https://www.instagram.com/${encodeURIComponent(handle)}/`;
  return withRateLimit('instagram.com', async () => {
    const page = await openPage(browser, 'instagram');
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await new Promise(r => setTimeout(r, 2500));
    await saveCookies(page, 'instagram');

    const meta = await page.evaluate(() => {
      const og = (n) => document.querySelector(`meta[property="og:${n}"]`)?.content || null;
      const desc = document.querySelector('meta[name="description"]')?.content || '';
      const m = desc.match(/([\d.,]+[KM]?)\s+Followers,\s+([\d.,]+[KM]?)\s+Following,\s+([\d.,]+[KM]?)\s+Posts/i);
      return { title: og('title'), image: og('image'), description: desc,
        parsed_counts: m ? { followers: m[1], following: m[2], posts: m[3] } : null };
    });

    const shared = await safeReadJsonFromPage(page, 'window\\._sharedData\\s*=\\s*(\\{.+?\\});');
    let userObj = null;
    if (shared) {
      try { userObj = shared?.entry_data?.ProfilePage?.[0]?.graphql?.user || null; } catch (_) {}
    }
    await page.close();
    return {
      handle, url,
      title: meta.title, description: meta.description, avatar: meta.image,
      counts: meta.parsed_counts,
      full_profile: userObj ? {
        full_name: userObj.full_name,
        biography: userObj.biography,
        external_url: userObj.external_url,
        followers: userObj.edge_followed_by?.count,
        following: userObj.edge_follow?.count,
        is_verified: userObj.is_verified,
        is_business_account: userObj.is_business_account,
        business_email: userObj.business_email,
        business_phone_number: userObj.business_phone_number,
        category_name: userObj.category_name,
      } : null,
      scraped_at: Date.now(),
    };
  });
}

async function scrapeRecent(browser, handle, n = 10) {
  const url = `https://www.instagram.com/${encodeURIComponent(handle)}/`;
  return withRateLimit('instagram.com', async () => {
    const page = await openPage(browser, 'instagram');
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await new Promise(r => setTimeout(r, 2500));

    const shared = await safeReadJsonFromPage(page, 'window\\._sharedData\\s*=\\s*(\\{.+?\\});');
    const posts = [];
    if (shared) {
      try {
        const edges = shared?.entry_data?.ProfilePage?.[0]?.graphql?.user?.edge_owner_to_timeline_media?.edges || [];
        for (const e of edges.slice(0, n)) {
          const node = e.node;
          posts.push({
            shortcode: node.shortcode,
            url: `https://www.instagram.com/p/${node.shortcode}/`,
            caption: node.edge_media_to_caption?.edges?.[0]?.node?.text || '',
            display_url: node.display_url,
            is_video: !!node.is_video,
            video_view_count: node.video_view_count || null,
            likes: node.edge_liked_by?.count || node.edge_media_preview_like?.count || null,
            comments: node.edge_media_to_comment?.count || null,
            taken_at_timestamp: node.taken_at_timestamp,
          });
        }
      } catch (_) {}
    }
    await page.close();
    return { handle, count: posts.length, posts, scraped_at: Date.now() };
  });
}

async function scrapeHashtag(browser, tag, limit = 20) {
  const cleaned = tag.replace(/^#/, '').toLowerCase();
  const url = `https://www.instagram.com/explore/tags/${encodeURIComponent(cleaned)}/`;
  return withRateLimit('instagram.com', async () => {
    const page = await openPage(browser, 'instagram');
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await new Promise(r => setTimeout(r, 2500));

    const shared = await safeReadJsonFromPage(page, 'window\\._sharedData\\s*=\\s*(\\{.+?\\});');
    const out = { hashtag: cleaned, url, total_media: null, top_posts: [], recent_posts: [] };
    if (shared) {
      try {
        const tagData = shared?.entry_data?.TagPage?.[0]?.graphql?.hashtag;
        if (tagData) {
          out.total_media = tagData.edge_hashtag_to_media?.count || null;
          const mapEdge = (e) => ({
            shortcode: e.node.shortcode,
            url: `https://www.instagram.com/p/${e.node.shortcode}/`,
            display_url: e.node.display_url,
            is_video: !!e.node.is_video,
            likes: e.node.edge_liked_by?.count || e.node.edge_media_preview_like?.count || null,
            comments: e.node.edge_media_to_comment?.count || null,
            caption: e.node.edge_media_to_caption?.edges?.[0]?.node?.text || '',
            taken_at_timestamp: e.node.taken_at_timestamp,
          });
          out.top_posts = (tagData.edge_hashtag_to_top_posts?.edges || []).slice(0, limit).map(mapEdge);
          out.recent_posts = (tagData.edge_hashtag_to_media?.edges || []).slice(0, limit).map(mapEdge);
        }
      } catch (_) {}
    }
    await page.close();
    out.scraped_at = Date.now();
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
    log.error('usage: --profile <handle> | --hashtag <tag> | --recent <handle> | --batch <file>');
    process.exit(2);
  }
  await withBrowser(async (browser) => {
    if (MODE === 'profile') {
      const data = await scrapeProfile(browser, TARGET);
      log.info(`profile ${TARGET} → ${saveResult('profile', TARGET, data)}`);
    } else if (MODE === 'recent') {
      const data = await scrapeRecent(browser, TARGET, COUNT);
      log.info(`recent ${TARGET} (${data.count} posts) → ${saveResult('recent', TARGET, data)}`);
    } else if (MODE === 'hashtag') {
      const data = await scrapeHashtag(browser, TARGET, LIMIT);
      log.info(`hashtag #${TARGET} (${data.top_posts.length} top + ${data.recent_posts.length} recent) → ${saveResult('hashtag', TARGET, data)}`);
    } else if (MODE === 'batch') {
      const handles = fs.readFileSync(TARGET, 'utf8').split(/\r?\n/).map(s => s.trim()).filter(Boolean);
      const results = [];
      for (const h of handles) {
        try {
          results.push(await scrapeProfile(browser, h));
          log.info(`  ${h} OK`);
        } catch (e) {
          log.warn(`  ${h} FAIL: ${e.message}`);
        }
      }
      log.info(`batch ${handles.length} handles → ${saveResult('batch', path.basename(TARGET, path.extname(TARGET)), { handles: handles.length, results })}`);
    }
  });
}

if (require.main === module) {
  main().catch(e => { log.error(`fatal: ${e.message}`); process.exit(1); });
}

module.exports = { scrapeProfile, scrapeRecent, scrapeHashtag };
