'use strict';
/**
 * lib/stealth-fetch.cjs — one function to fetch a page while evading bot detection.
 *
 * Tries the strongest method available on your machine, degrading gracefully:
 *   1. puppeteer-extra + stealth plugin  (if installed) — best evasion, renders JS
 *   2. plain puppeteer via lib/browser.cjs (if installed) — stealth launch args, renders JS
 *   3. plain HTTPS fetch with a rotating desktop User-Agent + realistic headers (always available, no deps)
 *
 * Returns a normalized shape regardless of which path ran:
 *   { ok, status, finalUrl, html, text, title, emails, links, method }
 *
 * Usage:
 *   const { stealthFetch } = require('./lib/stealth-fetch.cjs');
 *   const r = await stealthFetch('https://example.com', { render: true, waitMs: 1500 });
 *   console.log(r.method, r.status, r.emails);
 *
 * Env: STEALTH_PROXY=http://user:pass@host:port  (optional; used by the browser paths)
 */
const https = require('https');
const http = require('http');
const { URL } = require('url');

const { extractEmailsFromHtml } = require('./email-extract.cjs');

const UA_POOL = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
];
function pickUA() { return UA_POOL[Math.floor(Math.random() * UA_POOL.length)]; }

function titleOf(html) { const m = String(html || '').match(/<title[^>]*>([^<]*)<\/title>/i); return m ? m[1].trim() : null; }
function textOf(html) { return String(html || '').replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<style[\s\S]*?<\/style>/gi, ' ').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim(); }
function linksOf(html, base) {
  const out = new Set();
  for (const m of String(html || '').matchAll(/href=["']([^"'#]+)["']/gi)) {
    try { out.add(new URL(m[1], base).toString()); } catch (_) { /* skip bad href */ }
  }
  return [...out];
}
function normalize(html, status, finalUrl, method) {
  html = html || '';
  return { ok: status >= 200 && status < 400, status, finalUrl, html, text: textOf(html), title: titleOf(html), emails: extractEmailsFromHtml(html), links: linksOf(html, finalUrl), method };
}

/** Plain HTTPS/HTTP GET with realistic headers + redirect following. No deps. */
function plainFetch(url, { timeoutMs = 20000, maxRedirects = 5 } = {}) {
  return new Promise((resolve) => {
    const go = (u, redirectsLeft) => {
      let lib, opts;
      try { const parsed = new URL(u); lib = parsed.protocol === 'http:' ? http : https; }
      catch (_) { return resolve(normalize('', 0, u, 'http')); }
      opts = {
        headers: {
          'User-Agent': pickUA(),
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          'Accept-Language': 'en-US,en;q=0.9',
          'Accept-Encoding': 'identity',
          'Cache-Control': 'no-cache',
        },
        timeout: timeoutMs,
      };
      const req = lib.get(u, opts, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && redirectsLeft > 0) {
          res.resume();
          try { return go(new URL(res.headers.location, u).toString(), redirectsLeft - 1); } catch (_) { /* fall through */ }
        }
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (c) => { body += c; if (body.length > 5_000_000) req.destroy(); }); // 5MB cap
        res.on('end', () => resolve(normalize(body, res.statusCode || 0, u, 'http')));
      });
      req.on('timeout', () => req.destroy());
      req.on('error', () => resolve(normalize('', 0, u, 'http')));
    };
    go(url, maxRedirects);
  });
}

/** Try puppeteer-extra + stealth, then plain puppeteer (via browser.cjs). Returns null if neither is installed. */
async function renderFetch(url, { waitMs = 1500, timeoutMs = 45000 } = {}) {
  const proxy = process.env.STEALTH_PROXY || null;
  // 1. puppeteer-extra + stealth plugin — the strongest option if the user installed it.
  let launcher = null;
  try {
    const puppeteerExtra = require('puppeteer-extra');
    const StealthPlugin = require('puppeteer-extra-plugin-stealth');
    puppeteerExtra.use(StealthPlugin());
    launcher = { launch: (o) => puppeteerExtra.launch(o) };
  } catch (_) { launcher = null; }
  // 2. plain puppeteer via our shared browser.cjs (already sets stealth launch args).
  if (!launcher) {
    try { const { launchBrowser } = require('./browser.cjs'); launcher = { launch: (o) => launchBrowser(o) }; }
    catch (_) { launcher = null; }
  }
  if (!launcher) return null; // no browser engine installed → caller falls back to plainFetch

  let browser;
  try {
    browser = await launcher.launch({ headless: 'new', proxy });
    const page = await browser.newPage();
    await page.setUserAgent(pickUA());
    await page.setViewport({ width: 1366, height: 900 });
    await page.setExtraHTTPHeaders({ 'Accept-Language': 'en-US,en;q=0.9' });
    const resp = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: timeoutMs });
    if (waitMs) await new Promise((r) => setTimeout(r, waitMs));
    const html = await page.content();
    const status = (resp && resp.status && resp.status()) || 200;
    const finalUrl = page.url();
    return normalize(html, status, finalUrl, 'render');
  } catch (_) {
    return null; // render failed → caller falls back
  } finally {
    try { if (browser) await browser.close(); } catch (_) {}
  }
}

/**
 * stealthFetch(url, opts)
 *   opts.render  (default false) — use a real browser (stealth) if one is installed; else HTTP.
 *   opts.waitMs  — extra settle time after load when rendering (default 1500).
 *   opts.timeoutMs, opts.maxRedirects — passed through to the underlying fetch.
 */
async function stealthFetch(url, opts = {}) {
  if (opts.render) {
    const r = await renderFetch(url, opts);
    if (r) return r;
    // No browser engine available or render failed — transparently fall back to HTTP.
  }
  return plainFetch(url, opts);
}

module.exports = { stealthFetch, plainFetch, renderFetch, pickUA };

// CLI: node lib/stealth-fetch.cjs https://example.com [--render]
if (require.main === module) {
  const url = process.argv[2];
  if (!url) { console.error('Usage: node lib/stealth-fetch.cjs <url> [--render]'); process.exit(2); }
  stealthFetch(url, { render: process.argv.includes('--render') }).then((r) => {
    console.log(JSON.stringify({ method: r.method, status: r.status, title: r.title, emails: r.emails, links: r.links.length }, null, 2));
  });
}
