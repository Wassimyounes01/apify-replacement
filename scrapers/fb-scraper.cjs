#!/usr/bin/env node
'use strict';

/**
 * scrapers/fb-scraper.cjs — Facebook public-page scraper. Apify-free.
 *
 * Covers Apify actors:
 *   - facebook-pages-scraper
 *   - facebook-posts-scraper
 *
 * Strategy: m.facebook.com (mobile site) is the most parseable, less JS,
 * less anti-bot. For Page-owned data (insights), use the official Facebook
 * Graph API — but only on Pages you manage.
 *
 * Usage:
 *   node scrapers/fb-scraper.cjs --page <username-or-id>
 *   node scrapers/fb-scraper.cjs --posts <username-or-id> [--count 10]
 */

const fs = require('fs');
const path = require('path');
const { withBrowser, openPage, withRateLimit, saveCookies, saveJSON, loadEnv, log, DATA_DIR } = require('../lib/browser.cjs');
loadEnv();

const OUT_DIR = path.join(DATA_DIR, 'fb');
const HISTORY = path.join(DATA_DIR, 'fb-history.jsonl');

const arg = (n, d) => { const i = process.argv.indexOf(n); return i === -1 ? d : process.argv[i + 1]; };
const flag = (n) => process.argv.includes(n);

const MODE = arg('--page') ? 'page' : arg('--posts') ? 'posts' : null;
const TARGET = arg('--page') || arg('--posts');
const COUNT = parseInt(arg('--count', '10'), 10);

async function scrapePage(browser, slug) {
  const url = `https://m.facebook.com/${encodeURIComponent(slug)}/about`;
  return withRateLimit('facebook.com', async () => {
    const page = await openPage(browser, 'facebook');
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await new Promise(r => setTimeout(r, 3000));
    await saveCookies(page, 'facebook');

    const meta = await page.evaluate(() => {
      const og = (n) => document.querySelector(`meta[property="og:${n}"]`)?.content || null;
      const desc = document.querySelector('meta[name="description"]')?.content || '';
      const text = document.body?.innerText || '';
      const likesM = text.match(/([\d.,KM]+)\s+likes?/i);
      const followsM = text.match(/([\d.,KM]+)\s+follow(?:ers|s)/i);
      return {
        title: og('title'), image: og('image'), og_url: og('url'), description: desc,
        likes_raw: likesM?.[1] || null,
        follows_raw: followsM?.[1] || null,
        body_excerpt: text.slice(0, 4000),
      };
    });
    await page.close();
    return { slug, url, scraped_at: Date.now(), ...meta };
  });
}

async function scrapePosts(browser, slug, count = 10) {
  const url = `https://m.facebook.com/${encodeURIComponent(slug)}`;
  return withRateLimit('facebook.com', async () => {
    const page = await openPage(browser, 'facebook');
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await new Promise(r => setTimeout(r, 4000));

    for (let i = 0; i < Math.min(count, 5); i++) {
      await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
      await new Promise(r => setTimeout(r, 1500));
    }

    const posts = await page.evaluate((n) => {
      const containers = Array.from(document.querySelectorAll(
        'article, div[role="article"], div[data-store*="permalink"], div[data-ft]'
      )).slice(0, n);
      return containers.map(c => {
        const linkEl = c.querySelector('a[href*="/story.php"], a[href*="/posts/"], a[href*="/permalink"]');
        const text = (c.innerText || '').slice(0, 2000);
        const imgs = Array.from(c.querySelectorAll('img')).map(i => i.src).filter(Boolean).slice(0, 4);
        return { href: linkEl ? linkEl.href : null, text, images: imgs };
      });
    }, count);
    await page.close();
    return { slug, url, count: posts.length, posts, scraped_at: Date.now() };
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
    log.error('usage: --page <slug> | --posts <slug> [--count N]');
    process.exit(2);
  }
  await withBrowser(async (browser) => {
    let data;
    if (MODE === 'page') data = await scrapePage(browser, TARGET);
    else if (MODE === 'posts') data = await scrapePosts(browser, TARGET, COUNT);
    log.info(`${MODE} ${TARGET} → ${saveResult(MODE, TARGET, data)}`);
  });
}

if (require.main === module) {
  main().catch(e => { log.error(`fatal: ${e.message}`); process.exit(1); });
}

module.exports = { scrapePage, scrapePosts };
