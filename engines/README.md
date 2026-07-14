# Engines — bring your own crawler

The arsenal ships a **$0 built-in stealth fetcher** ([`../lib/stealth-fetch.cjs`](../lib/stealth-fetch.cjs)) that needs nothing but Node. If you already run a heavier crawler, plug it in here and **every scraper can use it through one contract** — no rewrites.

Adapters are **optional** and **degrade gracefully**: if the engine isn't installed or configured, the call transparently falls back to the built-in fetcher (pass `{ strict: true }` to disable the fallback and get an explicit "not installed" instead).

## Common contract

Every adapter resolves to the same shape (fields are best-effort per engine):

```js
{ ok, status, url, html, text, markdown, links, emails, engine }
```

## Supported engines

| Engine | What it is | How to enable | Best for |
|---|---|---|---|
| **builtin** | This repo's stealth fetcher (Puppeteer if installed, else plain HTTP) | always on | zero-setup, most sites |
| **crawl4ai** | Open-source LLM-friendly crawler (Python) | `pip install crawl4ai` | clean Markdown extraction for AI pipelines |
| **firecrawl** | Self-hosted or cloud crawl/scrape API | set `FIRECRAWL_API_URL` (+ `FIRECRAWL_API_KEY` for cloud) | JS-heavy sites, hosted scale |
| **scrapling** | Stealthy Python fetcher (`StealthyFetcher`) | `pip install scrapling` | anti-bot / Cloudflare-guarded pages |

> `crawl4ai` and `scrapling` are shelled out via Python — set `PYTHON_BIN` if your interpreter isn't `python`/`python3` on PATH. `firecrawl` runs over HTTP: point `FIRECRAWL_API_URL` at your self-hosted instance (`http://localhost:3002`) or the cloud API (`https://api.firecrawl.dev`).

## Usage

```js
const { fetchVia, available } = require('./engines');

// which engines are ready on this machine right now?
console.log(await available());   // -> { builtin:true, crawl4ai:false, firecrawl:false, scrapling:false }

// fetch through crawl4ai; if it isn't installed you still get a result (via builtin)
const r = await fetchVia('crawl4ai', 'https://example.com');
console.log(r.engine, r.status, r.emails, r.markdown?.length);
```

```bash
# list what's installed
node engines/index.cjs --list

# fetch one URL through a chosen engine
node engines/index.cjs firecrawl https://example.com
node engines/index.cjs builtin   https://example.com
```

Every scraper in this repo works with the built-in engine out of the box — the engines here are a **power-up**, not a requirement.
