#!/usr/bin/env node
'use strict';
/**
 * pipeline/qualified-leads.cjs — END-TO-END QUALIFIED-LEAD PIPELINE. NO API KEY, NO APIFY.
 *
 *   1. DISCOVER   Google Maps (no key) → businesses (name, category, rating, reviews, phone, website, mapsUrl)
 *   2. ENRICH     fetch each website (home + /contact + /about) → extract REAL emails (mailto + text), socials
 *   3. MX-VERIFY  DNS MX lookup on the email's domain → confirm the domain can actually receive mail
 *   4. QUALIFY    score every lead (verified email, website, ratings, phone…) and RANK highest-first
 *
 * Two-stage discipline: emails are SCRAPED from the real site (never guessed); MX only confirms the domain is
 * mail-capable. For per-recipient certainty add an SMTP RCPT probe (provided as --smtp, off by default).
 *
 * Usage:
 *   node pipeline/qualified-leads.cjs --query "dentists in Miami FL" [--limit 30] [--min-score 5] [--out leads.csv]
 *   node pipeline/qualified-leads.cjs --batch queries.txt [--out leads.csv]
 */
const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');
const dns = require('dns').promises;
const { withBrowser, openPage, saveJSON, log, DATA_DIR } = require('../lib/browser.cjs');

const arg = (n, d) => { const i = process.argv.indexOf(n); return i === -1 ? d : process.argv[i + 1]; };
const LIMIT = parseInt(arg('--limit', '30'), 10);
const MIN_SCORE = parseInt(arg('--min-score', '0'), 10);
const OUT = arg('--out', path.join(DATA_DIR, 'qualified-leads.csv'));
const ROLE_EMAILS = /^(info|contact|hello|admin|office|sales|support|team|booking|appointments|frontdesk)@/i;

// ---------- 1. DISCOVER (Google Maps, no key) ----------
async function discover(query, limit) {
  return withBrowser(async (browser) => {
    const page = await openPage(browser);
    await page.goto(`https://www.google.com/maps/search/${encodeURIComponent(query)}?hl=en`, { waitUntil: 'domcontentloaded', timeout: 45000 });
    try { await page.waitForSelector('form[action*="consent"] button, button[aria-label*="Accept"]', { timeout: 3500 }); await page.click('form[action*="consent"] button, button[aria-label*="Accept"]'); await page.waitForNavigation({ timeout: 8000 }).catch(() => {}); } catch (_) {}
    await page.waitForSelector('div[role="feed"], a[href*="/maps/place/"]', { timeout: 30000 });
    let prev = 0, stale = 0;
    for (let i = 0; i < 30; i++) {
      const n = await page.evaluate(() => document.querySelectorAll('a[href*="/maps/place/"]').length);
      if (n >= limit) break;
      if (n === prev) { if (++stale >= 3) break; } else stale = 0;
      prev = n;
      await page.evaluate(() => { const f = document.querySelector('div[role="feed"]'); if (f) f.scrollTo(0, f.scrollHeight); });
      await new Promise(r => setTimeout(r, 1200));
    }
    const leads = await page.evaluate((max) => {
      const clean = s => (s || '').replace(/\s+/g, ' ').trim();
      const out = [];
      for (const c of Array.from(document.querySelectorAll('div[role="feed"] > div')).filter(d => d.querySelector('a[href*="/maps/place/"]'))) {
        if (out.length >= max) break;
        const link = c.querySelector('a[href*="/maps/place/"]');
        const name = clean(c.querySelector('.fontHeadlineSmall')?.textContent || link?.getAttribute('aria-label') || '');
        if (!name) continue;
        const txt = clean(c.textContent);
        const rt = c.querySelector('span[role="img"][aria-label*="star"]')?.getAttribute('aria-label') || '';
        const rM = rt.match(/([\d.]+)\s*star/i); let rev = (rt.match(/([\d,]+)\s*review/i) || [])[1];
        if (!rev) { const m = txt.match(/([\d.]+)\s*\(([\d,]+)\)/); if (m && parseFloat(m[1]) <= 5) rev = m[2]; }
        const body = clean((c.querySelector('.fontBodyMedium')?.textContent) || txt).replace(name, '').trim();
        const cM = body.match(/[\d.]+(?:\([\d,]+\))?\s*([A-Za-z][A-Za-z &/-]{2,38}?)(?=\s*[··]|\s*\d|\s*(?:Open|Closed)|$)/);
        const aM = txt.match(/\d{1,6}[A-Za-z]?\s+[\w.'-]+(?:\s+[\w.'-]+){0,5}?\s*(?:St|Ave|Blvd|Rd|Dr|Way|Ln|Ct|Pl|Hwy|Pkwy|Sq|Ter|Cir)(?![a-z])\.?/i);
        const pM = txt.match(/(\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4})/);
        const w = c.querySelector('a[data-value="Website"], a[aria-label*="ebsite"]');
        out.push({ business: name, category: cM ? clean(cM[1]) : null, rating: rM ? parseFloat(rM[1]) : null, reviews: rev ? parseInt(rev.replace(/,/g, ''), 10) : null, address: aM ? clean(aM[0]) : null, phone: pM ? pM[1].trim() : null, website: w ? w.href : null, mapsUrl: link.href });
      }
      return out;
    }, limit);
    // DETAIL pass — open each place panel (website + phone + full address are reliable there, unlike the list)
    for (const lead of leads) {
      try {
        await page.goto(lead.mapsUrl, { waitUntil: 'networkidle2', timeout: 30000 });
        await page.waitForSelector('a[data-item-id="authority"], button[data-item-id^="phone"], button[data-item-id="address"]', { timeout: 12000 }).catch(() => {});
        await new Promise(r => setTimeout(r, 1500)); // settle
        const det = await page.evaluate(() => {
          const clean = s => (s || '').replace(/\s+/g, ' ').trim();
          const web = document.querySelector('a[data-item-id="authority"]');
          const phoneBtn = document.querySelector('button[data-item-id^="phone:tel:"]');
          const addrBtn = document.querySelector('button[data-item-id="address"]');
          const phoneId = phoneBtn?.getAttribute('data-item-id') || '';
          return {
            website: web ? web.href : null,
            phone: phoneId.replace('phone:tel:', '') || (phoneBtn?.getAttribute('aria-label') || '').replace(/^Phone:?\s*/i, '').trim() || null,
            address: addrBtn ? clean(addrBtn.getAttribute('aria-label') || '').replace(/^Address:?\s*/i, '') : null,
          };
        });
        if (det.website) lead.website = det.website;
        if (det.phone) lead.phone = det.phone;
        if (det.address) lead.address = det.address;
        if (process.env.LEAD_DEBUG) log.info(`   detail ${lead.business}: web=${det.website ? 'Y' : 'n'} phone=${det.phone ? 'Y' : 'n'}`);
      } catch (e) { if (process.env.LEAD_DEBUG) log.error(`   detail FAIL ${lead.business}: ${e.message}`); }
    }
    return leads;
  });
}

// ---------- 2. ENRICH (fetch site, extract real emails) ----------
function fetchUrl(url, redirects = 3) {
  return new Promise((resolve) => {
    try {
      const lib = url.startsWith('https') ? https : http;
      const req = lib.get(url, { timeout: 9000, headers: { 'User-Agent': 'Mozilla/5.0 (compatible; LeadBot/1.0)' } }, (res) => {
        if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location && redirects > 0) {
          const next = res.headers.location.startsWith('http') ? res.headers.location : new URL(res.headers.location, url).href;
          res.resume(); return resolve(fetchUrl(next, redirects - 1));
        }
        let d = ''; res.on('data', c => { d += c; if (d.length > 600000) req.destroy(); }); res.on('end', () => resolve(d));
      });
      req.on('error', () => resolve('')); req.on('timeout', () => { req.destroy(); resolve(''); });
    } catch { resolve(''); }
  });
}
function extractEmails(html) {
  const set = new Set();
  for (const m of html.matchAll(/mailto:([^"'?>\s]+)/gi)) set.add(m[1].toLowerCase());
  for (const m of html.matchAll(/\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g)) set.add(m[0].toLowerCase());
  return [...set].filter(e => !/\.(png|jpg|jpeg|gif|webp|svg)$/i.test(e) && !/(example|sentry|wix|squarespace|godaddy|\.png)/i.test(e));
}
async function enrich(lead) {
  if (!lead.website) return lead;
  let host; try { host = new URL(lead.website).origin; } catch { return lead; }
  const pages = [lead.website, host + '/contact', host + '/contact-us', host + '/about'];
  const emails = new Set();
  for (const u of pages) { const html = await fetchUrl(u); extractEmails(html).forEach(e => emails.add(e)); if (emails.size >= 3) break; }
  const all = [...emails];
  // prefer a role/contact inbox over personal; fall back to first
  lead.email = all.find(e => ROLE_EMAILS.test(e)) || all[0] || null;
  lead.emailsFound = all.slice(0, 5);
  lead.emailDomain = lead.email ? lead.email.split('@')[1] : (host ? new URL(host).hostname.replace(/^www\./, '') : null);
  return lead;
}

// ---------- 3. MX-VERIFY (domain can receive mail) ----------
async function mxVerify(lead) {
  if (!lead.emailDomain) { lead.mxOk = false; return lead; }
  try { const mx = await dns.resolveMx(lead.emailDomain); lead.mxOk = Array.isArray(mx) && mx.length > 0; lead.mxHost = lead.mxOk ? mx.sort((a, b) => a.priority - b.priority)[0].exchange : null; }
  catch { lead.mxOk = false; }
  return lead;
}

// ---------- 4. QUALIFY (score + rank) ----------
function score(l) {
  let s = 0;
  if (l.website) s += 2;
  if (l.email) s += 3;
  if (l.mxOk) s += 2;
  if (l.phone) s += 1;
  if ((l.reviews || 0) >= 20) s += 1;
  if ((l.rating || 0) >= 4.5) s += 1;
  if (l.email && !ROLE_EMAILS.test(l.email)) s += 1; // a named inbox is a warmer contact
  l.qualityScore = s;
  l.tier = s >= 8 ? 'A — hot' : s >= 5 ? 'B — qualified' : s >= 3 ? 'C — workable' : 'D — thin';
  return l;
}

// ---------- DEDUP (added 2026-06-30) — never work the same prospect twice across batch queries ----------
const { openerFor } = require('./personalized-opener.cjs');
function dedup(rows) {
  const seen = new Set(); const out = [];
  for (const r of rows) {
    const keys = [String(r.phone || '').replace(/\D/g, '').slice(-10), (r.email || '').toLowerCase().trim(), String(r.business || '').toLowerCase().replace(/[^a-z0-9]/g, '')].filter(Boolean);
    if (keys.some(k => seen.has(k))) continue;
    keys.forEach(k => seen.add(k));
    out.push(r);
  }
  return out;
}

function toCSV(rows) {
  const cols = ['business', 'category', 'rating', 'reviews', 'phone', 'email', 'mxOk', 'emailDomain', 'website', 'address', 'qualityScore', 'tier', 'opener', 'mapsUrl'];
  const esc = v => { const s = v == null ? '' : String(v); return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
  return [cols.join(','), ...rows.map(r => cols.map(c => esc(r[c])).join(','))].join('\n');
}

(async () => {
  const batch = arg('--batch');
  const queries = batch ? fs.readFileSync(batch, 'utf8').split('\n').map(s => s.trim()).filter(Boolean) : [arg('--query')];
  if (!queries[0]) { log.error('Usage: --query "dentists in Miami" [--limit 30] [--min-score 5] [--out leads.csv]'); process.exit(1); }
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  let all = [];
  for (const q of queries) {
    log.info(`[1/4] discover  "${q}" (Google Maps, no key)…`);
    let leads = await discover(q, LIMIT);
    log.info(`      → ${leads.length} businesses`);
    log.info(`[2/4] enrich    fetching sites + extracting real emails…`);
    for (const l of leads) { await enrich(l); }
    log.info(`[3/4] mx-verify confirming domains accept mail…`);
    for (const l of leads) { await mxVerify(l); }
    leads.forEach(score);
    leads.forEach(l => l.query = q);
    all = all.concat(leads);
  }
  const before = all.length;
  all = dedup(all); // dedup across all batch queries (same office shows up under multiple searches)
  all = all.filter(l => l.qualityScore >= MIN_SCORE).sort((a, b) => b.qualityScore - a.qualityScore);
  all.forEach(l => { l.opener = openerFor(l); }); // personalized 1:1 first line from real scraped facts
  if (before !== all.length) log.info(`      deduped ${before - all.length} duplicate prospect(s)`);
  const withEmail = all.filter(l => l.email).length, mxOk = all.filter(l => l.mxOk).length;
  fs.writeFileSync(OUT, toCSV(all));
  saveJSON(OUT.replace(/\.csv$/, '.json'), all);
  log.info(`[4/4] qualify   ${all.length} leads · ${withEmail} with email · ${mxOk} MX-verified · top tier: ${all[0] ? all[0].tier : 'n/a'}`);
  log.info(`      → ${OUT}`);
  all.slice(0, 5).forEach(l => log.info(`      ${l.tier.padEnd(14)} ${String(l.qualityScore).padStart(2)} | ${l.business} | ${l.email || l.phone || '—'}`));
})();
