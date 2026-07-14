#!/usr/bin/env node
'use strict';

/**
 * scrapers/google-business-scraper.cjs — Google Business Profile / Maps. Apify-free.
 *
 * Covers Apify actors:
 *   - google-maps-scraper
 *   - google-places-scraper
 *   - google-reviews-scraper
 *
 * Uses Google Maps Platform official APIs:
 *   - Places Text Search (find businesses)
 *   - Place Details (full info including reviews)
 *
 * Free tier: $200/month credit (covers ~28k Text Search + 10k Place Details).
 *
 * Get a key at: console.cloud.google.com → APIs & Services
 *   Enable: Places API (New)
 *
 * Usage:
 *   node scrapers/google-business-scraper.cjs --query "dentists in Brooklyn" [--limit 20]
 *   node scrapers/google-business-scraper.cjs --place-id <placeId>
 *   node scrapers/google-business-scraper.cjs --batch queries.txt
 */

const fs = require('fs');
const path = require('path');
const https = require('https');
const { saveJSON, loadEnv, log, DATA_DIR } = require('../lib/browser.cjs');
loadEnv();

const API_KEY = process.env.GOOGLE_MAPS_API_KEY || '';
const OUT_DIR = path.join(DATA_DIR, 'google-biz');
const HISTORY = path.join(DATA_DIR, 'google-biz-history.jsonl');

const arg = (n, d) => { const i = process.argv.indexOf(n); return i === -1 ? d : process.argv[i + 1]; };

const MODE = arg('--query') ? 'query' : arg('--place-id') ? 'place' : arg('--batch') ? 'batch' : null;
const TARGET = arg('--query') || arg('--place-id') || arg('--batch');
const LIMIT = parseInt(arg('--limit', '20'), 10);

function post(url, body) {
  return new Promise((resolve, reject) => {
    const payload = Buffer.from(JSON.stringify(body));
    const u = new URL(url);
    const req = https.request({
      hostname: u.hostname,
      path: u.pathname + u.search,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': payload.length,
        'X-Goog-Api-Key': API_KEY,
        'X-Goog-FieldMask': '*',
      },
    }, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(data) }); }
        catch (e) { reject(new Error(`parse error: ${e.message}`)); }
      });
    });
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

function get(url) {
  return new Promise((resolve, reject) => {
    https.get(url, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(data) }); }
        catch (e) { reject(new Error(`parse error: ${e.message}`)); }
      });
    }).on('error', reject);
  });
}

async function searchPlaces(query, limit = 20) {
  if (!API_KEY) throw new Error('GOOGLE_MAPS_API_KEY not set');
  const r = await post('https://places.googleapis.com/v1/places:searchText', {
    textQuery: query,
    pageSize: Math.min(limit, 20),
  });
  if (r.status !== 200) throw new Error(`Places API ${r.status}: ${JSON.stringify(r.body).slice(0, 300)}`);
  return (r.body.places || []).slice(0, limit).map(p => ({
    place_id: p.id,
    name: p.displayName?.text,
    address: p.formattedAddress,
    phone: p.nationalPhoneNumber || p.internationalPhoneNumber,
    website: p.websiteUri,
    rating: p.rating,
    review_count: p.userRatingCount,
    types: p.types,
    location: p.location,
    business_status: p.businessStatus,
    price_level: p.priceLevel,
  }));
}

async function placeDetails(placeId) {
  if (!API_KEY) throw new Error('GOOGLE_MAPS_API_KEY not set');
  const r = await get(`https://places.googleapis.com/v1/places/${encodeURIComponent(placeId)}?fields=*&key=${API_KEY}`);
  if (r.status !== 200) throw new Error(`Places API ${r.status}: ${JSON.stringify(r.body).slice(0, 300)}`);
  const p = r.body;
  return {
    place_id: p.id,
    name: p.displayName?.text,
    address: p.formattedAddress,
    phone: p.nationalPhoneNumber || p.internationalPhoneNumber,
    website: p.websiteUri,
    rating: p.rating,
    review_count: p.userRatingCount,
    hours: p.regularOpeningHours?.weekdayDescriptions,
    types: p.types,
    location: p.location,
    reviews: (p.reviews || []).map(rv => ({
      author: rv.authorAttribution?.displayName,
      rating: rv.rating,
      text: rv.text?.text,
      published_at: rv.publishTime,
      relative_time: rv.relativePublishTimeDescription,
    })),
    photos_count: (p.photos || []).length,
    summary: p.editorialSummary?.text,
  };
}

function saveResult(mode, target, data) {
  const ts = Date.now();
  const file = path.join(OUT_DIR, `${mode}-${String(target).replace(/[^a-z0-9_-]/gi, '_').slice(0, 80)}-${ts}.json`);
  saveJSON(file, data);
  try { fs.appendFileSync(HISTORY, JSON.stringify({ ts, mode, target, ok: !!data, file }) + '\n'); } catch (_) {}
  return file;
}

async function main() {
  if (!MODE) {
    log.error('usage: --query "<text>" | --place-id <id> | --batch <file>');
    process.exit(2);
  }
  if (!API_KEY) {
    log.error('GOOGLE_MAPS_API_KEY not set. See .env.example.');
    process.exit(2);
  }
  if (MODE === 'query') {
    const places = await searchPlaces(TARGET, LIMIT);
    log.info(`search "${TARGET}": ${places.length} places → ${saveResult('query', TARGET, { query: TARGET, count: places.length, places, scraped_at: Date.now() })}`);
  } else if (MODE === 'place') {
    const details = await placeDetails(TARGET);
    log.info(`place ${TARGET}: ${details.review_count} reviews → ${saveResult('place', TARGET, { ...details, scraped_at: Date.now() })}`);
  } else if (MODE === 'batch') {
    const queries = fs.readFileSync(TARGET, 'utf8').split(/\r?\n/).map(s => s.trim()).filter(s => s && !s.startsWith('#'));
    const results = [];
    for (const q of queries) {
      try {
        const places = await searchPlaces(q, LIMIT);
        results.push({ query: q, count: places.length, places });
        log.info(`  "${q}": ${places.length}`);
      } catch (e) {
        results.push({ query: q, error: e.message });
      }
    }
    log.info(`batch ${queries.length} queries → ${saveResult('batch', path.basename(TARGET, path.extname(TARGET)), { queries: results, scraped_at: Date.now() })}`);
  }
}

if (require.main === module) {
  main().catch(e => { log.error(`fatal: ${e.message}`); process.exit(1); });
}

module.exports = { searchPlaces, placeDetails };
