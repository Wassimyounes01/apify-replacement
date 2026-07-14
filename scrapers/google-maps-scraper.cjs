#!/usr/bin/env node
'use strict';
/**
 * scrapers/google-maps-scraper.cjs — Google Maps + Google Business Profile (GMB) scraper. NO API KEY, NO APIFY.
 *
 * Replaces Apify actors:  apify/google-maps-scraper, apify/google-places-scraper (list-level).
 * Drives a real browser to the Maps search results, scrolls the feed to load listings, and extracts each
 * business: name, category, rating, reviews, address, phone, website, Maps URL. $0, self-hosted, no key.
 *
 * For COMPLETE per-place detail (full address, all reviews, hours, attributes) use the official-API companion
 * scrapers/google-business-scraper.cjs (Google Places API, $200/mo free credit). This one needs no key at all.
 *
 * Usage:
 *   node scrapers/google-maps-scraper.cjs --query "dentists in Brooklyn NY" [--limit 40]
 *   node scrapers/google-maps-scraper.cjs --batch queries.txt [--limit 40]
 *   (set USE_BROWSERBASE=1 + BROWSERBASE_API_KEY for residential-IP runs at scale — see lib/browser.cjs)
 */
const fs = require('fs');
const path = require('path');
const { withBrowser, openPage, saveJSON, log, DATA_DIR } = require('../lib/browser.cjs');

const arg = (n, d) => { const i = process.argv.indexOf(n); return i === -1 ? d : process.argv[i + 1]; };
const LIMIT = parseInt(arg('--limit', '30'), 10);
const OUT_DIR = path.join(DATA_DIR, 'google-maps');

async function scrapeQuery(query, limit) {
  return withBrowser(async (browser) => {
    const page = await openPage(browser);
    await page.goto(`https://www.google.com/maps/search/${encodeURIComponent(query)}?hl=en`, { waitUntil: 'domcontentloaded', timeout: 45000 });
    // EU consent gate
    try { await page.waitForSelector('form[action*="consent"] button, button[aria-label*="Accept"]', { timeout: 3500 }); await page.click('form[action*="consent"] button, button[aria-label*="Accept"]'); await page.waitForNavigation({ timeout: 8000 }).catch(() => {}); } catch (_) {}
    await page.waitForSelector('div[role="feed"], a[href*="/maps/place/"]', { timeout: 30000 });
    // scroll the results feed until we have `limit` listings (or it stops growing)
    let prev = 0, stale = 0;
    for (let i = 0; i < 30; i++) {
      const n = await page.evaluate(() => document.querySelectorAll('a[href*="/maps/place/"]').length);
      if (n >= limit) break;
      if (n === prev) { if (++stale >= 3) break; } else stale = 0;
      prev = n;
      await page.evaluate(() => { const f = document.querySelector('div[role="feed"]'); if (f) f.scrollTo(0, f.scrollHeight); });
      await new Promise(r => setTimeout(r, 1200));
    }
    return page.evaluate((max) => {
      const clean = s => (s || '').replace(/\s+/g, ' ').trim();
      const out = [];
      const cards = Array.from(document.querySelectorAll('div[role="feed"] > div')).filter(d => d.querySelector('a[href*="/maps/place/"]'));
      for (const c of cards) {
        if (out.length >= max) break;
        const link = c.querySelector('a[href*="/maps/place/"]');
        const name = clean(c.querySelector('.fontHeadlineSmall')?.textContent || link?.getAttribute('aria-label') || '');
        if (!name) continue;
        const txt = clean(c.textContent);
        const ratingTxt = c.querySelector('span[role="img"][aria-label*="star"]')?.getAttribute('aria-label') || '';
        const ratingM = ratingTxt.match(/([\d.]+)\s*star/i);
        let reviews = (ratingTxt.match(/([\d,]+)\s*review/i) || [])[1];
        if (!reviews) { const rm = txt.match(/([\d.]+)\s*\(([\d,]+)\)/); if (rm && parseFloat(rm[1]) <= 5) reviews = rm[2]; }
        const body = clean((c.querySelector('.fontBodyMedium')?.textContent) || txt).replace(name, '').trim();
        const catM = body.match(/[\d.]+(?:\([\d,]+\))?\s*([A-Za-z][A-Za-z &/-]{2,38}?)(?=\s*[··]|\s*\d|\s*(?:Open|Closed|Opens|Closes)|$)/);
        const category = catM ? clean(catM[1]).replace(/\$+$/, '') : null;
        const addrM = txt.match(/\d{1,6}[A-Za-z]?\s+[\w.'-]+(?:\s+[\w.'-]+){0,5}?\s*(?:St|Ave|Blvd|Rd|Dr|Way|Ln|Ct|Pl|Hwy|Pkwy|Sq|Ter|Cir)(?![a-z])\.?(?:\s*(?:#|Ste\.?|Suite|Fl\.?|Floor|Unit)\s*\w+)?/i);
        const phoneM = txt.match(/(\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4})/);
        const websiteEl = c.querySelector('a[data-value="Website"], a[aria-label*="ebsite"]');
        out.push({
          business: name,
          category: category && category.toLowerCase() !== name.toLowerCase() ? category : null,
          rating: ratingM ? parseFloat(ratingM[1]) : null,
          reviews: reviews ? parseInt(reviews.replace(/,/g, ''), 10) : null,
          address: addrM ? clean(addrM[0]) : null,
          phone: phoneM ? phoneM[1].trim() : null,
          website: websiteEl ? websiteEl.href : null,
          mapsUrl: link.href,
        });
      }
      return out;
    }, limit);
  });
}

(async () => {
  const batch = arg('--batch');
  const queries = batch ? fs.readFileSync(batch, 'utf8').split('\n').map(s => s.trim()).filter(Boolean) : [arg('--query')];
  if (!queries[0]) { log.error('Usage: --query "dentists in Brooklyn" [--limit 40] | --batch queries.txt'); process.exit(1); }
  fs.mkdirSync(OUT_DIR, { recursive: true });
  for (const q of queries) {
    log.info(`Google Maps (no key, no Apify): "${q}"`);
    const t = Date.now();
    try {
      const rows = await scrapeQuery(q, LIMIT);
      const file = path.join(OUT_DIR, q.replace(/[^a-z0-9]+/gi, '-').toLowerCase().slice(0, 60) + '.json');
      saveJSON(file, rows);
      log.info(`  → ${rows.length} businesses in ${((Date.now() - t) / 1000).toFixed(1)}s → ${file}`);
    } catch (e) { log.error(`  ✗ ${q}: ${e.message}`); }
  }
})();
