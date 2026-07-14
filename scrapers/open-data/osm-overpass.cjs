#!/usr/bin/env node
'use strict';
/**
 * scrapers/open-data/osm-overpass.cjs — FREE local-business scrape via the OpenStreetMap Overpass API.
 *
 * No key, no cost, no rate card. OpenStreetMap publishes rich business data — name, phone, website, email
 * (for some), address, and social links — under the open ODbL license. Overpass lets you query it by
 * category inside any bounding box. This is a genuine, unlimited replacement for paid local-business
 * lead APIs for the (large) subset of businesses that maintain an OSM presence.
 *
 * Categories (curated for local-service lead-gen; edit CATEGORIES below to add your own):
 *   contractor            — craft=plumber/electrician/hvac/roofer/... + trade shops
 *   business              — office=estate_agent/company/insurance/lawyer/...
 *   premises              — businesses with physical premises (hotels, gyms, clinics, car dealers...)
 *   appointment-services  — appointment-based local services (salon, dentist, gym, vet, spa...)
 *
 * Usage:
 *   node osm-overpass.cjs --bbox=40.49,-74.26,40.92,-73.70 contractor business
 *   node osm-overpass.cjs --bbox=<S,W,N,E> appointment-services --state=NY --out=./data
 *
 * A bounding box is "south,west,north,east" in decimal degrees. Grab one from
 * https://boundingbox.klokantech.com (CSV format) for any city/region you want.
 *
 * Output: <out>/osm-<date>.{json,csv}  (default out: ./data)
 */
const fs = require('fs');
const path = require('path');

// Overpass mirrors, tried in order — if one is slow/504 the next is used automatically.
const ENDPOINTS = [
  'https://overpass.openstreetmap.fr/api/interpreter',
  'https://overpass.private.coffee/api/interpreter',
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
  'https://lz4.overpass-api.de/api/interpreter',
];
const USER_AGENT = process.env.OSM_USER_AGENT || 'osm-overpass-scraper/1.0 (open-data lead tool)';

// Category → OSM tag selectors. `nwr` = nodes+ways+relations. Extend freely.
const CATEGORIES = {
  contractor: [
    'nwr["craft"~"plumber|electrician|hvac|roofer|carpenter|painter|gardener|tiler|floorer|stonemason|metal_construction|insulation|scaffolder|chimney_sweeper|builder|glazier|joiner|plasterer|window_construction|handyman"]',
    'nwr["shop"~"trade|doityourself|hardware|paint|flooring|bathroom_furnishing|kitchen|fireplace|garden_centre"]',
  ],
  business: [
    'nwr["office"~"estate_agent|property_management|company|insurance|construction_company|lawyer|accountant|architect|financial|it|advertising_agency|employment_agency|tax_advisor"]',
  ],
  premises: [
    'nwr["tourism"~"hotel|motel|guest_house"]',
    'nwr["leisure"~"fitness_centre|sports_centre"]',
    'nwr["amenity"~"clinic|veterinary|car_wash|fuel|bank|dentist|nightclub"]',
    'nwr["shop"~"car|car_repair|supermarket|furniture"]',
  ],
  'appointment-services': [
    'nwr["shop"~"hairdresser|beauty|massage|tattoo|nails"]',
    'nwr["amenity"~"dentist|pharmacy|childcare|veterinary|clinic|doctors|kindergarten"]',
    'nwr["leisure"~"fitness_centre|spa|dance|sports_centre"]',
  ],
};

function buildQuery(category, bbox) {
  const selectors = CATEGORIES[category];
  if (!selectors) throw new Error(`unknown category "${category}". Known: ${Object.keys(CATEGORIES).join(', ')}`);
  const body = selectors.map((s) => `${s}(${bbox});`).join(' ');
  return `[out:json][timeout:150];(${body});out center tags;`;
}

function ensureDir(p) { try { fs.mkdirSync(p, { recursive: true }); } catch (_) {} }
function csvEscape(v) { if (v == null) return ''; const s = String(v); return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; }
function norm(s) { return String(s || '').trim().toLowerCase(); }
function last10(p) { return String(p || '').replace(/\D/g, '').slice(-10); }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function runOverpass(query) {
  for (const url of ENDPOINTS) {
    try {
      const r = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': USER_AGENT },
        body: 'data=' + encodeURIComponent(query),
        signal: AbortSignal.timeout(150000),
      });
      const t = await r.text();
      if (t.trim()[0] === '{') return JSON.parse(t).elements || [];
      console.log(`  ${url} -> non-JSON (status ${r.status}); trying next mirror`);
    } catch (e) { console.log(`  ${url} -> ${e.message}; trying next mirror`); }
    await sleep(2000);
  }
  return [];
}

function mapElement(el, category) {
  const t = el.tags || {};
  const addr = [t['addr:housenumber'], t['addr:street']].filter(Boolean).join(' ');
  const social = {};
  if ((t['contact:facebook'] || '').trim()) social.facebook = t['contact:facebook'].trim();
  if ((t['contact:instagram'] || '').trim()) social.instagram = t['contact:instagram'].trim();
  if ((t['contact:linkedin'] || '').trim()) social.linkedin = t['contact:linkedin'].trim();
  return {
    category,
    // Strip page-title artifacts an OSM name can carry (" | City" tail, " - Home of X") so the stored name is clean.
    business_name: (() => { const n = String(t.name || t.operator || '').replace(/\s*\|\s.*$/, '').replace(/\s+[-–]\s*Home\b.*$/i, '').trim(); return n || null; })(),
    phone: t.phone || t['contact:phone'] || t['contact:mobile'] || null,
    website: t.website || t['contact:website'] || null,
    // Reject a non-@ value — bad OSM data sometimes puts a URL in the email tag; keep email SENDABLE.
    email: (() => { const e = (t.email || t['contact:email'] || '').trim(); return e.includes('@') ? e : null; })(),
    street_address: addr || null,
    city: t['addr:city'] || null,
    state: t['addr:state'] || null,
    postal_code: t['addr:postcode'] || null,
    tag: t.craft || t.shop || t.office || t.tourism || t.leisure || t.amenity || null,
    maps_url: el.type && el.id ? `https://www.openstreetmap.org/${el.type}/${el.id}` : null,
    source: 'openstreetmap',
    social_profiles: Object.keys(social).length ? social : null,
  };
}

function parseArgs(argv) {
  const flags = {};
  const positional = [];
  for (const a of argv) {
    if (a.startsWith('--')) { const [k, v] = a.slice(2).split('='); flags[k] = v === undefined ? true : v; }
    else positional.push(a);
  }
  return { flags, positional };
}

async function main() {
  const { flags, positional } = parseArgs(process.argv.slice(2));
  const bbox = flags.bbox;
  if (!bbox || !/^-?\d+(\.\d+)?,-?\d+(\.\d+)?,-?\d+(\.\d+)?,-?\d+(\.\d+)?$/.test(bbox)) {
    console.error('Usage: node osm-overpass.cjs --bbox=<south,west,north,east> [category...] [--state=XX] [--out=./data]');
    console.error('Categories: ' + Object.keys(CATEGORIES).join(', '));
    process.exit(2);
  }
  const outDir = flags.out || './data';
  const stateFilter = flags.state ? String(flags.state).toUpperCase() : null;
  const categories = positional.length ? positional : ['contractor', 'business'];

  ensureDir(outDir);
  console.log(`FREE OpenStreetMap Overpass scrape — bbox ${bbox} — categories: ${categories.join(', ')}`);
  const all = [];
  const seen = new Set();
  for (const category of categories) {
    console.log(`\n  querying ${category}…`);
    const els = await runOverpass(buildQuery(category, bbox));
    let kept = 0;
    for (const el of els) {
      const m = mapElement(el, category);
      if (!m.business_name) continue;
      if (stateFilter && (m.state || '').toUpperCase() !== stateFilter) continue;
      const key = `${norm(m.business_name)}|${last10(m.phone)}`;
      if (seen.has(key)) continue;
      seen.add(key);
      all.push(m); kept++;
    }
    console.log(`  ${category}: ${els.length} OSM elements -> ${kept} named unique leads`);
    await sleep(2000);
  }

  const stamp = new Date().toISOString().slice(0, 10);
  const jsonPath = path.join(outDir, `osm-${stamp}.json`);
  fs.writeFileSync(jsonPath, JSON.stringify({ scraped_at: new Date().toISOString(), source: 'openstreetmap-overpass', bbox, cost_usd: 0, total: all.length, data: all }, null, 2));
  const headers = ['category', 'business_name', 'phone', 'website', 'email', 'street_address', 'city', 'state', 'postal_code', 'tag', 'maps_url'];
  const lines = [headers.join(',')];
  for (const r of all) lines.push(headers.map((h) => csvEscape(r[h])).join(','));
  fs.writeFileSync(path.join(outDir, `osm-${stamp}.csv`), lines.join('\n'));

  const withPhone = all.filter((r) => r.phone).length;
  const withWeb = all.filter((r) => r.website).length;
  const withEmail = all.filter((r) => r.email).length;
  console.log(`\n✓ FREE: ${all.length} leads -> ${jsonPath}`);
  console.log(`  with phone: ${withPhone} (${pct(withPhone, all.length)})  website: ${withWeb} (${pct(withWeb, all.length)})  email: ${withEmail} (${pct(withEmail, all.length)})`);
  console.log('  cost: $0.00');
}
function pct(n, d) { return d ? Math.round((n / d) * 100) + '%' : '0%'; }

module.exports = { buildQuery, runOverpass, mapElement, CATEGORIES };
if (require.main === module) main().catch((e) => { console.error('FATAL:', e.message); process.exit(1); });
