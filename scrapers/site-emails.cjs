#!/usr/bin/env node
'use strict';
/**
 * scrapers/site-emails.cjs — find a business's real emails + phones from its website, for $0.
 *
 * Give it a domain (or a JSON/CSV of leads with `website`) and it visits the homepage plus the usual
 * contact pages, decodes obfuscated addresses (Cloudflare, HTML entities, "name [at] domain [dot] com"),
 * and returns clean, de-duplicated emails + phone numbers. This is the enrichment step that turns a
 * name+website lead (from the maps / open-data scrapers) into an emailable, callable contact.
 *
 * Respects robots.txt by default (pass --ignore-robots to override for sites you own/are authorized to scan).
 * Uses the built-in stealth fetcher — no API key, no third-party service.
 *
 * Usage:
 *   node site-emails.cjs example-biz.com
 *   node site-emails.cjs example-biz.com --render          # use a real browser (JS-rendered sites)
 *   node site-emails.cjs --in=leads.json --out=enriched.json
 */
const fs = require('fs');
const { URL } = require('url');
const { stealthFetch, plainFetch } = require('../lib/stealth-fetch.cjs');
const { extractEmailsFromHtml } = require('../lib/email-extract.cjs');

const CONTACT_PATHS = ['', '/contact', '/contact-us', '/contactus', '/about', '/about-us', '/team', '/support', '/get-in-touch'];
const PHONE_RE = /(?:\+?\d{1,2}[\s.\-]?)?(?:\(\d{3}\)|\d{3})[\s.\-]?\d{3}[\s.\-]?\d{4}\b/g;

function toOrigin(input) {
  let s = String(input || '').trim();
  if (!s) return null;
  if (!/^https?:\/\//i.test(s)) s = 'https://' + s;
  try { const u = new URL(s); return u.origin; } catch (_) { return null; }
}

async function robotsAllows(origin, ignore) {
  if (ignore) return true;
  try {
    const r = await plainFetch(origin + '/robots.txt', { timeoutMs: 8000 });
    if (!r.ok || !r.html) return true; // no robots => allowed
    // Very small conservative check: honor a global "Disallow: /" under User-agent: *.
    const lines = r.html.split(/\r?\n/).map((l) => l.trim().toLowerCase());
    let star = false, disallowAll = false;
    for (const l of lines) {
      if (l.startsWith('user-agent:')) star = l.includes('*');
      else if (star && l.startsWith('disallow:')) { if (l.replace('disallow:', '').trim() === '/') disallowAll = true; }
      else if (l === '') star = false;
    }
    return !disallowAll;
  } catch (_) { return true; }
}

function extractPhones(text) {
  const out = new Set();
  for (const m of String(text || '').matchAll(PHONE_RE)) {
    const digits = m[0].replace(/\D/g, '');
    if (digits.length >= 10 && digits.length <= 12) out.add(m[0].trim());
  }
  return [...out];
}

/** Crawl one site's contact pages → { emails, phones, pages_hit }. */
async function findContacts(domain, { render = false, ignoreRobots = false, maxPages = 6 } = {}) {
  const origin = toOrigin(domain);
  if (!origin) return { domain, origin: null, emails: [], phones: [], pages_hit: 0, error: 'bad domain' };
  if (!(await robotsAllows(origin, ignoreRobots))) return { domain, origin, emails: [], phones: [], pages_hit: 0, error: 'blocked by robots.txt' };

  const emails = new Set(), phones = new Set();
  let hit = 0;
  for (const p of CONTACT_PATHS.slice(0, maxPages)) {
    const url = origin + p;
    const r = await stealthFetch(url, { render, timeoutMs: render ? 30000 : 15000 });
    if (!r.ok) continue;
    hit++;
    for (const e of r.emails) emails.add(e);
    for (const e of extractEmailsFromHtml(r.html)) emails.add(e);
    for (const ph of extractPhones(r.text)) phones.add(ph);
  }
  return { domain, origin, emails: [...emails], phones: [...phones], pages_hit: hit };
}

function loadLeads(file) {
  const raw = fs.readFileSync(file, 'utf8');
  if (file.endsWith('.json')) { const j = JSON.parse(raw); return Array.isArray(j) ? j : (j.data || []); }
  // CSV: expect a header with a "website" (or "domain"/"url") column
  const lines = raw.split(/\r?\n/).filter(Boolean);
  const header = lines.shift().split(',').map((h) => h.trim().toLowerCase());
  const wi = header.findIndex((h) => ['website', 'domain', 'url'].includes(h));
  return lines.map((l) => { const c = l.split(','); return { website: (c[wi] || '').trim() }; });
}

function parseArgs(argv) {
  const flags = {}; const positional = [];
  for (const a of argv) { if (a.startsWith('--')) { const [k, v] = a.slice(2).split('='); flags[k] = v === undefined ? true : v; } else positional.push(a); }
  return { flags, positional };
}

async function main() {
  const { flags, positional } = parseArgs(process.argv.slice(2));
  const render = !!flags.render;
  const ignoreRobots = !!flags['ignore-robots'];

  if (flags.in) {
    const leads = loadLeads(flags.in).filter((l) => l.website || l.domain || l.url);
    console.log(`enriching ${leads.length} leads from ${flags.in}…`);
    const results = [];
    for (const l of leads) {
      const c = await findContacts(l.website || l.domain || l.url, { render, ignoreRobots });
      results.push({ ...l, emails: c.emails, phones: c.phones, primary_email: c.emails[0] || null });
      console.log(`  ${c.origin || l.website}: ${c.emails.length} email(s), ${c.phones.length} phone(s)`);
    }
    const out = flags.out || 'enriched.json';
    fs.writeFileSync(out, JSON.stringify({ enriched_at: new Date().toISOString(), total: results.length, data: results }, null, 2));
    console.log(`\n✓ wrote ${results.length} enriched leads -> ${out}`);
    return;
  }

  const domain = positional[0];
  if (!domain) { console.error('Usage: node site-emails.cjs <domain> [--render] [--ignore-robots]  |  --in=leads.json [--out=enriched.json]'); process.exit(2); }
  const c = await findContacts(domain, { render, ignoreRobots });
  console.log(JSON.stringify(c, null, 2));
}

module.exports = { findContacts, extractPhones, toOrigin };
if (require.main === module) main().catch((e) => { console.error('FATAL:', e.message); process.exit(1); });
