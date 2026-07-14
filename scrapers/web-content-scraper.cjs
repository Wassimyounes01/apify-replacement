#!/usr/bin/env node
'use strict';

/**
 * scrapers/web-content-scraper.cjs — generic web scraper. Apify-free.
 *
 * Covers Apify actors:
 *   - web-scraper (generic)
 *   - website-content-crawler
 *   - cheerio-scraper (lighter alternative)
 *
 * Strategy: Puppeteer fully renders JS, extracts visible text + metadata +
 * email/phone patterns. For lightweight scraping (static HTML) you can swap
 * Puppeteer out for Cheerio later — this version handles both.
 *
 * Usage:
 *   node scrapers/web-content-scraper.cjs --url https://example.com
 *   node scrapers/web-content-scraper.cjs --crawl https://example.com --depth 2 --max-pages 20
 *   node scrapers/web-content-scraper.cjs --batch urls.txt
 */

const fs = require('fs');
const path = require('path');
const { withBrowser, openPage, withRateLimit, saveJSON, loadEnv, log, DATA_DIR } = require('../lib/browser.cjs');
loadEnv();

const OUT_DIR = path.join(DATA_DIR, 'web');
const HISTORY = path.join(DATA_DIR, 'web-history.jsonl');

const arg = (n, d) => { const i = process.argv.indexOf(n); return i === -1 ? d : process.argv[i + 1]; };

const MODE = arg('--url') ? 'url' : arg('--crawl') ? 'crawl' : arg('--batch') ? 'batch' : null;
const TARGET = arg('--url') || arg('--crawl') || arg('--batch');
const DEPTH = parseInt(arg('--depth', '1'), 10);
const MAX_PAGES = parseInt(arg('--max-pages', '20'), 10);

const EMAIL_RE = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi;
const PHONE_RE = /\+?\d[\d\s().-]{7,}\d/g;

async function scrapeUrl(browser, url) {
  const u = new URL(url);
  return withRateLimit(u.hostname, async () => {
    const page = await openPage(browser);
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await new Promise(r => setTimeout(r, 1500));

    const data = await page.evaluate(() => {
      const meta = {};
      document.querySelectorAll('meta').forEach(m => {
        const k = m.getAttribute('property') || m.getAttribute('name');
        if (k) meta[k] = m.getAttribute('content');
      });
      const links = Array.from(document.querySelectorAll('a[href]')).map(a => a.href).filter(Boolean);
      const text = (document.body?.innerText || '').slice(0, 50000);
      const title = document.title;
      return { meta, links, text, title };
    });

    const emails = Array.from(new Set((data.text.match(EMAIL_RE) || []).map(e => e.toLowerCase())));
    const phones = Array.from(new Set(data.text.match(PHONE_RE) || []));
    await page.close();
    return {
      url, title: data.title,
      description: data.meta.description || data.meta['og:description'],
      og_image: data.meta['og:image'],
      og_title: data.meta['og:title'],
      emails, phones,
      link_count: data.links.length,
      sample_links: data.links.slice(0, 30),
      text_excerpt: data.text.slice(0, 2000),
      full_text: data.text,
      scraped_at: Date.now(),
    };
  });
}

async function crawl(browser, startUrl, depth = 1, maxPages = 20) {
  const visited = new Set();
  const start = new URL(startUrl);
  const queue = [{ url: startUrl, depth: 0 }];
  const results = [];

  while (queue.length && results.length < maxPages) {
    const { url, depth: d } = queue.shift();
    if (visited.has(url)) continue;
    visited.add(url);
    try {
      const r = await scrapeUrl(browser, url);
      results.push(r);
      log.info(`  [depth ${d}] ${url} — ${r.emails.length}e/${r.phones.length}p`);
      if (d < depth) {
        for (const link of r.sample_links) {
          try {
            const lu = new URL(link, url);
            if (lu.hostname === start.hostname && !visited.has(lu.href)) {
              queue.push({ url: lu.href, depth: d + 1 });
            }
          } catch (_) {}
        }
      }
    } catch (e) {
      log.warn(`  [fail] ${url}: ${e.message}`);
    }
  }
  return { start_url: startUrl, depth, max_pages: maxPages, pages: results, scraped_at: Date.now() };
}

function saveResult(mode, target, data) {
  const ts = Date.now();
  const safe = String(target).replace(/[^a-z0-9_-]/gi, '_').slice(0, 80);
  const file = path.join(OUT_DIR, `${mode}-${safe}-${ts}.json`);
  saveJSON(file, data);
  try { fs.appendFileSync(HISTORY, JSON.stringify({ ts, mode, target, ok: !!data, file }) + '\n'); } catch (_) {}
  return file;
}

async function main() {
  if (!MODE) {
    log.error('usage: --url <url> | --crawl <url> [--depth N --max-pages M] | --batch <file>');
    process.exit(2);
  }
  await withBrowser(async (browser) => {
    if (MODE === 'url') {
      const data = await scrapeUrl(browser, TARGET);
      log.info(`url ${TARGET} → ${saveResult('url', TARGET, data)}`);
    } else if (MODE === 'crawl') {
      const data = await crawl(browser, TARGET, DEPTH, MAX_PAGES);
      log.info(`crawl ${TARGET} (${data.pages.length} pages) → ${saveResult('crawl', TARGET, data)}`);
    } else if (MODE === 'batch') {
      const urls = fs.readFileSync(TARGET, 'utf8').split(/\r?\n/).map(s => s.trim()).filter(s => s && !s.startsWith('#'));
      const results = [];
      for (const u of urls) {
        try { results.push(await scrapeUrl(browser, u)); log.info(`  ${u} OK`); }
        catch (e) { results.push({ url: u, error: e.message }); log.warn(`  ${u} FAIL: ${e.message}`); }
      }
      log.info(`batch ${urls.length} urls → ${saveResult('batch', path.basename(TARGET, path.extname(TARGET)), { count: urls.length, results })}`);
    }
  });
}

if (require.main === module) {
  main().catch(e => { log.error(`fatal: ${e.message}`); process.exit(1); });
}

module.exports = { scrapeUrl, crawl };
