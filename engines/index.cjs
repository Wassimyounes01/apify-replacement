'use strict';
/**
 * engines/index.cjs — bring-your-own-engine layer.
 *
 * The arsenal ships its own $0 stealth fetcher (../lib/stealth-fetch.cjs) that needs nothing but Node.
 * But if you already run a heavier crawler, plug it in here and every scraper can use it through ONE
 * contract — no rewrites. Adapters are OPTIONAL and degrade gracefully: if the engine isn't installed
 * or configured, the adapter reports unavailable and callers fall back to the built-in fetcher.
 *
 * Supported engines (all optional, all yours to install):
 *   crawl4ai   — open-source LLM-friendly crawler (Python). Shells to its CLI; great Markdown extraction.
 *   firecrawl  — self-hosted or cloud crawl/scrape API. Uses FIRECRAWL_API_URL (+ FIRECRAWL_API_KEY).
 *   scrapling  — stealthy Python fetcher. Shells to a tiny inline script using its StealthyFetcher.
 *   builtin    — this repo's lib/stealth-fetch.cjs (always available; the default).
 *
 * Common contract — every adapter resolves to:
 *   { ok, status, url, html, text, markdown, links, emails, engine }   (fields best-effort per engine)
 *
 * Usage:
 *   const { fetchVia, available } = require('./engines');
 *   const r = await fetchVia('crawl4ai', 'https://example.com');   // falls back to builtin if crawl4ai absent
 *   console.log(await available());                                 // -> { builtin:true, crawl4ai:false, ... }
 */
const { spawn } = require('child_process');
const https = require('https');
const http = require('http');
const { URL } = require('url');

const { stealthFetch } = require('../lib/stealth-fetch.cjs');
const { extractEmailsFromHtml } = require('../lib/email-extract.cjs');

function pyBin() { return process.env.PYTHON_BIN || (process.platform === 'win32' ? 'python' : 'python3'); }

/** Run a command, capture stdout, resolve {code, out, err}. Never rejects. */
function run(cmd, args, { input = null, timeoutMs = 90000 } = {}) {
  return new Promise((resolve) => {
    let out = '', err = '', done = false;
    let child;
    try { child = spawn(cmd, args, { windowsHide: true }); }
    catch (e) { return resolve({ code: -1, out: '', err: String(e.message) }); }
    const timer = setTimeout(() => { if (!done) { try { child.kill(); } catch (_) {} } }, timeoutMs);
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (err += d));
    child.on('error', (e) => { if (!done) { done = true; clearTimeout(timer); resolve({ code: -1, out, err: String(e.message) }); } });
    child.on('close', (code) => { if (!done) { done = true; clearTimeout(timer); resolve({ code, out, err }); } });
    if (input != null) { try { child.stdin.write(input); child.stdin.end(); } catch (_) {} }
  });
}

function derive(html, url, extra = {}) {
  html = html || '';
  const text = extra.text != null ? extra.text : html.replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<style[\s\S]*?<\/style>/gi, ' ').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
  const links = extra.links || (() => { const s = new Set(); for (const m of html.matchAll(/href=["']([^"'#]+)["']/gi)) { try { s.add(new URL(m[1], url).toString()); } catch (_) {} } return [...s]; })();
  return { ok: true, status: extra.status || 200, url, html, text, markdown: extra.markdown || null, links, emails: extractEmailsFromHtml(html + ' ' + (extra.markdown || '')), engine: extra.engine };
}

// ── crawl4ai ────────────────────────────────────────────────────────────────
// Uses the crawl4ai Python package via a tiny inline script (async API). Returns HTML + Markdown.
const crawl4ai = {
  async check() { const r = await run(pyBin(), ['-c', 'import crawl4ai'], { timeoutMs: 15000 }); return r.code === 0; },
  async fetch(url, opts = {}) {
    const py = [
      'import asyncio, json, sys',
      'from crawl4ai import AsyncWebCrawler',
      'async def main():',
      '    async with AsyncWebCrawler() as c:',
      '        r = await c.arun(url=sys.argv[1])',
      '        print(json.dumps({"html": r.html or "", "markdown": (r.markdown or ""), "links": [l.get("href") for l in (r.links or {}).get("internal", []) if l.get("href")], "status": getattr(r, "status_code", 200)}))',
      'asyncio.run(main())',
    ].join('\n');
    const r = await run(pyBin(), ['-c', py, url], { timeoutMs: opts.timeoutMs || 120000 });
    if (r.code !== 0) return { ok: false, status: 0, url, error: (r.err || 'crawl4ai failed').slice(0, 200), engine: 'crawl4ai' };
    try { const j = JSON.parse(r.out.trim().split('\n').pop()); return derive(j.html, url, { markdown: j.markdown, links: j.links, status: j.status, engine: 'crawl4ai' }); }
    catch (e) { return { ok: false, status: 0, url, error: 'crawl4ai parse: ' + e.message, engine: 'crawl4ai' }; }
  },
};

// ── firecrawl ─────────────────────────────────────────────────────────────────
// Self-hosted (FIRECRAWL_API_URL=http://localhost:3002) or cloud (https://api.firecrawl.dev + FIRECRAWL_API_KEY).
const firecrawl = {
  check() { return Promise.resolve(!!process.env.FIRECRAWL_API_URL || !!process.env.FIRECRAWL_API_KEY); },
  fetch(url, opts = {}) {
    const base = (process.env.FIRECRAWL_API_URL || 'https://api.firecrawl.dev').replace(/\/$/, '');
    const endpoint = `${base}/v1/scrape`;
    const payload = JSON.stringify({ url, formats: ['html', 'markdown', 'links'] });
    return new Promise((resolve) => {
      let lib; try { lib = new URL(endpoint).protocol === 'http:' ? http : https; } catch (_) { return resolve({ ok: false, status: 0, url, error: 'bad FIRECRAWL_API_URL', engine: 'firecrawl' }); }
      const headers = { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) };
      if (process.env.FIRECRAWL_API_KEY) headers.Authorization = 'Bearer ' + process.env.FIRECRAWL_API_KEY;
      const req = lib.request(endpoint, { method: 'POST', headers, timeout: opts.timeoutMs || 120000 }, (res) => {
        let body = ''; res.on('data', (c) => (body += c));
        res.on('end', () => {
          try {
            const j = JSON.parse(body);
            const d = j.data || j;
            resolve(derive(d.html || '', url, { markdown: d.markdown || null, links: d.links || null, status: res.statusCode, engine: 'firecrawl' }));
          } catch (e) { resolve({ ok: false, status: res.statusCode || 0, url, error: 'firecrawl parse: ' + e.message, engine: 'firecrawl' }); }
        });
      });
      req.on('timeout', () => req.destroy());
      req.on('error', (e) => resolve({ ok: false, status: 0, url, error: String(e.message), engine: 'firecrawl' }));
      req.write(payload); req.end();
    });
  },
};

// ── scrapling ─────────────────────────────────────────────────────────────────
// Uses Scrapling's StealthyFetcher (Python) for anti-detection page loads.
const scrapling = {
  async check() { const r = await run(pyBin(), ['-c', 'import scrapling'], { timeoutMs: 15000 }); return r.code === 0; },
  async fetch(url, opts = {}) {
    const py = [
      'import json, sys',
      'from scrapling.fetchers import StealthyFetcher',
      'p = StealthyFetcher.fetch(sys.argv[1], headless=True, network_idle=True)',
      'print(json.dumps({"html": p.html_content or "", "status": getattr(p, "status", 200)}))',
    ].join('\n');
    const r = await run(pyBin(), ['-c', py, url], { timeoutMs: opts.timeoutMs || 120000 });
    if (r.code !== 0) return { ok: false, status: 0, url, error: (r.err || 'scrapling failed').slice(0, 200), engine: 'scrapling' };
    try { const j = JSON.parse(r.out.trim().split('\n').pop()); return derive(j.html, url, { status: j.status, engine: 'scrapling' }); }
    catch (e) { return { ok: false, status: 0, url, error: 'scrapling parse: ' + e.message, engine: 'scrapling' }; }
  },
};

// ── builtin (always available) ──────────────────────────────────────────────
const builtin = {
  check() { return Promise.resolve(true); },
  async fetch(url, opts = {}) {
    const r = await stealthFetch(url, { render: opts.render !== false, ...opts });
    return { ok: r.ok, status: r.status, url: r.finalUrl || url, html: r.html, text: r.text, markdown: null, links: r.links, emails: r.emails, engine: 'builtin' };
  },
};

const ENGINES = { crawl4ai, firecrawl, scrapling, builtin };

/** Which engines are installed/configured right now. */
async function available() {
  const out = {};
  for (const [name, eng] of Object.entries(ENGINES)) { try { out[name] = await eng.check(); } catch (_) { out[name] = false; } }
  return out;
}

/** Fetch a URL via the named engine. If that engine is unavailable/fails, transparently fall back to builtin. */
async function fetchVia(engine, url, opts = {}) {
  const eng = ENGINES[engine];
  if (!eng) throw new Error(`unknown engine "${engine}". Known: ${Object.keys(ENGINES).join(', ')}`);
  if (engine !== 'builtin') {
    const ok = await eng.check().catch(() => false);
    if (!ok) { if (opts.strict) return { ok: false, status: 0, url, error: `${engine} not installed/configured`, engine }; return builtin.fetch(url, opts); }
    const r = await eng.fetch(url, opts);
    if (r.ok || opts.strict) return r;
    return builtin.fetch(url, opts); // engine ran but failed → fall back
  }
  return builtin.fetch(url, opts);
}

module.exports = { fetchVia, available, ENGINES };

// CLI: node engines/index.cjs <engine> <url>   |   node engines/index.cjs --list
if (require.main === module) {
  (async () => {
    if (process.argv.includes('--list') || process.argv.length < 4) {
      console.log('installed engines:', JSON.stringify(await available(), null, 2));
      console.log('\nUsage: node engines/index.cjs <crawl4ai|firecrawl|scrapling|builtin> <url>');
      return;
    }
    const [, , engine, url] = process.argv;
    const r = await fetchVia(engine, url);
    console.log(JSON.stringify({ engine: r.engine, ok: r.ok, status: r.status, emails: r.emails, links: (r.links || []).length, markdown_chars: (r.markdown || '').length }, null, 2));
  })();
}
