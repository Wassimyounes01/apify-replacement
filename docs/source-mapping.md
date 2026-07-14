# Apify Actor → This Toolkit Mapping

If your team is dropping Apify, here's the 1:1 replacement table for every
common actor.

| Apify Actor | This toolkit | Notes |
|---|---|---|
| `apify/instagram-profile-scraper` | `scrapers/ig-scraper.cjs --profile <handle>` | Parses `_sharedData` from public profile page. Returns bio, followers, business email/phone if exposed |
| `apify/instagram-hashtag-scraper` | `scrapers/ig-scraper.cjs --hashtag <tag>` | Returns top + recent posts, total media count |
| `apify/instagram-post-scraper` | `scrapers/ig-scraper.cjs --recent <handle> --count N` | Returns last N posts with engagement |
| `apify/instagram-comment-scraper` | (use Facebook Graph API on connected accounts; public comments require Puppeteer extension — easy to add) | |
| `apify/instagram-reel-scraper` | `scrapers/ig-scraper.cjs --recent <handle>` (returns `is_video`, view counts when present) | |
| custom multi-target tracker | `scrapers/ig-competitor-tracker.cjs --watchlist <file>` | Diffs against persisted state, surfaces new posts + engagement deltas |
| `apify/tiktok-scraper` | `scrapers/tiktok-scraper.cjs --profile <handle>` | Parses `__UNIVERSAL_DATA_FOR_REHYDRATION__` |
| `apify/tiktok-hashtag-scraper` | `scrapers/tiktok-scraper.cjs --hashtag <tag>` | |
| `apify/tiktok-trending-videos-scraper` | `scrapers/tiktok-scraper.cjs --trending` | |
| `apify/facebook-pages-scraper` | `scrapers/fb-scraper.cjs --page <slug>` | Uses m.facebook.com, simpler DOM |
| `apify/facebook-posts-scraper` | `scrapers/fb-scraper.cjs --posts <slug> --count N` | |
| `apify/facebook-comment-scraper` | (use Facebook Graph API on connected pages) | Public comment scraping is high-risk; use Graph API on your own pages |
| `apify/youtube-comments-scraper` | `scrapers/yt-comments.cjs --video <id>` | YouTube Data API v3, 10k free units/day |
| `apify/youtube-channel-videos-scraper` | `scrapers/yt-comments.cjs --channel <id>` | |
| `apify/google-maps-scraper` | **`scrapers/google-maps-scraper.cjs --query "dentists in Brooklyn"`** | **NO API KEY, NO APIFY** — drives a real browser, returns name, category, rating, reviews, address, phone, website, Maps URL. `--batch queries.txt` for bulk lead lists. |
| `apify/google-places-scraper` (full detail) | `scrapers/google-business-scraper.cjs --query "..."` / `--place-id <id>` | Official Google Places API ($200/mo free credit ≈ 28k searches) — use when you need EVERY field (full address, all reviews, hours, attributes). |
| `apify/google-reviews-scraper` | `scrapers/google-business-scraper.cjs --place-id <id>` (reviews included in details) | |
| `apify/web-scraper` | `scrapers/web-content-scraper.cjs --url <url>` | Full Puppeteer render |
| `apify/website-content-crawler` | `scrapers/web-content-scraper.cjs --crawl <url> --depth N` | Same-domain crawl |
| `apify/cheerio-scraper` | (use `web-content-scraper.cjs` for now; Cheerio-only variant easy to add for static-HTML sites) | |
| `apify/email-extractor` | `scrapers/web-content-scraper.cjs --url <url>` returns `emails[]` | Email + phone regex bundled in |
| `apify/contact-info-scraper` | Same as above | |
| `apify/youtube-video-downloader` | `clipper/yt-clipper.cjs` (uses yt-dlp under the hood) | |
| `apify/audio-extractor` | `clipper/yt-clipper.cjs` (ffmpeg step inside the pipeline) | |
| `apify/whisper-transcriber` | `clipper/yt-transcribe.cjs` or step 2 of `yt-clipper.cjs` | Uses local Whisper (free) or OpenAI Whisper API (~$0.006/min) |
| `apify/video-clipper` | `clipper/yt-clipper.cjs` | Modes: hooks (AI-picked moments), even, script (user-supplied timestamps) |
| `apify/subtitle-burner` | `clipper/yt-clipper.cjs` (built into clip step) | Arial Bold, white text + black outline, bottom-center |

## What this toolkit does NOT cover (yet)

- **Twitter/X**: no scraper here. X locked their unauth API in 2023. Options: (a) official paid API tier, (b) `playwright` with logged-in session — easy to add as a `tw-scraper.cjs` if needed.
- **LinkedIn**: no scraper here. LI aggressively blocks scraping. Options: (a) Sales Navigator API for paid tier, (b) headless browser with logged-in session (high ToS risk).
- **Reddit**: not Apify-territory in the first place — use the official Reddit API (free).
- **Amazon/eBay/Shopify product/price**: easy to add via `web-content-scraper.cjs` selectors per site, or use Stagehand for AI-driven selectors.

## How to add a new scraper

Pattern is consistent across all scrapers — copy `scrapers/fb-scraper.cjs` as a template and:
1. Replace the target URL pattern
2. Replace the extractor (`page.evaluate(...)`)
3. Rename the CLI flags
4. Done.

All scrapers share `lib/browser.cjs` for Puppeteer setup, cookie persistence, rate limiting, and optional Browserbase routing.
