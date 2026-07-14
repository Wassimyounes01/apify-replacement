#!/usr/bin/env node
'use strict';
/**
 * scrapers/open-data/socrata-licenses.cjs — FREE state license-DB lead source.
 *
 * US state professional-license boards publish licensee data as free open data (Socrata SODA JSON APIs
 * or bulk CSV) — no key, no paywall. For contractors and other licensed trades this gives business +
 * person name + phone + address + trade + license-status at large scale (WA ~56k active, CA ~245k).
 * These records carry NO email (state policy) — recover email downstream with the site email crawler
 * (../../lib/email-crawler.cjs) or the enrichment engine. This is a free cold-call + discovery pipeline.
 *
 * Verified public endpoints (extend STATE_CONFIGS with any Socrata /resource/<id>.json):
 *   WA — data.wa.gov/resource/m8qx-ubtq.json   (Socrata; phone+address+name+trade)
 *   CA — cslb.ca.gov MasterLicenseData CSV       (bulk CSV; phone+address+trade)
 *   CT — data.ct.gov/resource/5r9m-qgni.json     (Socrata; name+trade+city)
 *   TX — data.texas.gov/resource/7358-krk7.json  (Socrata; business+owner+trade)
 *
 * CLI: node socrata-licenses.cjs WA --limit 25 [--trade electrical] [--all]
 */
const https = require('https');

const STATE_CONFIGS = {
  WA: {
    mode: 'socrata',
    base: 'https://data.wa.gov/resource/m8qx-ubtq.json',
    status: { field: 'contractorlicensestatus', active: 'ACTIVE' },
    tradeField: 'specialtycode1desc',
    map: { business_name: 'businessname', contact_name: 'primaryprincipalname', phone: 'phonenumber', street_address: 'address1', city: 'city', state: 'state', postal_code: 'zip', industry: 'specialtycode1desc', license_number: 'contractorlicensenumber' },
  },
  CA: {
    mode: 'csv',
    url: 'https://www.cslb.ca.gov/OnlineServices/DataPortal/DownLoadFile.ashx?fName=MasterLicenseData&type=C',
    status: { field: 'PrimaryStatus', active: ['CLEAR'] },
    tradeField: 'Classifications(s)',
    map: { business_name: 'BusinessName', contact_name: 'FullBusinessName', phone: 'BusinessPhone', street_address: 'MailingAddress', city: 'City', state: 'State', postal_code: 'ZIPCode', industry: 'Classifications(s)', license_number: 'LicenseNo' },
  },
  CT: {
    mode: 'socrata',
    base: 'https://data.ct.gov/resource/5r9m-qgni.json',
    status: { field: 'status', active: 'ACTIVE' },
    tradeField: 'credential',
    map: { business_name: 'businessname', contact_name: 'name', phone: null, street_address: null, city: 'city', state: 'state', postal_code: 'zip', industry: 'credential', license_number: 'fullcredentialcode' },
  },
  TX: {
    mode: 'socrata',
    base: 'https://data.texas.gov/resource/7358-krk7.json',
    status: null, // no status field; dataset is current licenses
    tradeField: 'license_type',
    map: { business_name: 'business_name', contact_name: 'owner_name', phone: null, street_address: null, city: null, state: null, postal_code: null, industry: 'license_type', license_number: 'license_number' },
  },
};

const USER_AGENT = process.env.SOCRATA_USER_AGENT || 'socrata-licenses-scraper/1.0 (open-data lead tool)';

/** "LAST, FIRST MIDDLE" -> "First Last" (title-cased). Leaves business names alone. */
function tidyName(s) {
  const v = String(s || '').trim();
  if (!v) return null;
  const tc = (x) => x.toLowerCase().replace(/\b([a-z])/g, (m) => m.toUpperCase());
  if (v.includes(',')) { const [last, rest] = v.split(','); const first = (rest || '').trim().split(/\s+/)[0] || ''; return tc(`${first} ${last}`.trim()); }
  return tc(v);
}

function getJson(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'User-Agent': USER_AGENT, 'Accept': 'application/json' } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) { getJson(res.headers.location).then(resolve, reject); return; }
      let body = ''; res.on('data', (c) => (body += c));
      res.on('end', () => { try { resolve(JSON.parse(body)); } catch (e) { reject(new Error(`bad json (${res.statusCode}): ${body.slice(0, 120)}`)); } });
    }).on('error', reject);
  });
}

function mapRow(row, cfg, state) {
  const m = cfg.map;
  const get = (k) => (k && row[k] != null ? String(row[k]).trim() : null);
  return {
    source: `license:${state}`,
    source_id: `${state}:${get(m.license_number) || get(m.business_name)}`,
    business_name: get(m.business_name),
    contact_name: tidyName(get(m.contact_name)),
    phone: get(m.phone),
    street_address: get(m.street_address),
    city: get(m.city),
    state: get(m.state) || state,
    postal_code: get(m.postal_code),
    industry: get(m.industry),
    license_number: get(m.license_number),
    license_status: cfg.status ? get(cfg.status.field) : null,
    email: null, // license boards don't publish email — enrich downstream
  };
}

/** Socrata SODA path. opts: { activeOnly, limit, trade } */
async function fetchSocrata(cfg, state, { activeOnly = true, limit = 200, trade = null } = {}) {
  const where = [];
  if (activeOnly && cfg.status) where.push(`${cfg.status.field}='${cfg.status.active}'`);
  const fetchN = trade ? Math.min(limit * 6, 5000) : limit; // over-fetch when trade-filtering client-side
  const qs = [`$limit=${fetchN}`];
  if (where.length) qs.push(`$where=${encodeURIComponent(where.join(' AND '))}`);
  const rows = await getJson(`${cfg.base}?${qs.join('&')}`);
  if (!Array.isArray(rows)) throw new Error(`socrata returned non-array: ${JSON.stringify(rows).slice(0, 120)}`);
  let leads = rows.map((r) => mapRow(r, cfg, state));
  if (trade) leads = leads.filter((l) => String(l.industry || '').toLowerCase().includes(trade.toLowerCase()));
  return leads.slice(0, limit);
}

/** Quote-aware CSV line splitter (RFC-4180-ish). */
function parseCsvLine(line) {
  const out = []; let cur = ''; let inQ = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQ) { if (ch === '"') { if (line[i + 1] === '"') { cur += '"'; i++; } else inQ = false; } else cur += ch; }
    else if (ch === '"') inQ = true;
    else if (ch === ',') { out.push(cur); cur = ''; }
    else cur += ch;
  }
  out.push(cur); return out;
}

/** Bulk-CSV path (e.g. CA CSLB). Streams + parses line-by-line, aborts after `limit`. */
function fetchCsv(cfg, state, { activeOnly = true, limit = 200, trade = null } = {}) {
  return new Promise((resolve, reject) => {
    const leads = []; let header = null; let buf = ''; let done = false;
    const activeSet = new Set((Array.isArray(cfg.status.active) ? cfg.status.active : [cfg.status.active]).map((s) => s.toUpperCase()));
    const finish = (res) => { if (done) return; done = true; try { res && res.destroy(); } catch (_) {} resolve(leads); };
    https.get(cfg.url, { headers: { 'User-Agent': USER_AGENT } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) { res.destroy(); fetchCsv({ ...cfg, url: res.headers.location }, state, { activeOnly, limit, trade }).then(resolve, reject); return; }
      res.on('data', (chunk) => {
        if (done) return;
        buf += chunk;
        let nl;
        while ((nl = buf.indexOf('\n')) !== -1) {
          const line = buf.slice(0, nl).replace(/\r$/, ''); buf = buf.slice(nl + 1);
          if (!line) continue;
          const cells = parseCsvLine(line);
          if (!header) { header = cells; continue; }
          const row = {}; header.forEach((h, i) => (row[h] = cells[i]));
          if (activeOnly && !activeSet.has(String(row[cfg.status.field] || '').toUpperCase())) continue;
          if (trade && cfg.tradeField && !String(row[cfg.tradeField] || '').toLowerCase().includes(trade.toLowerCase())) continue;
          leads.push(mapRow(row, cfg, state));
          if (leads.length >= limit) return finish(res);
        }
      });
      res.on('end', () => finish());
      res.on('error', (e) => { if (!done) { done = true; reject(e); } });
    }).on('error', reject);
  });
}

/** Pull licensed leads for a state. Returns mapped leads (no email — enrich later). */
async function syncLicenses(state, opts = {}) {
  const key = String(state).toUpperCase();
  const cfg = STATE_CONFIGS[key];
  if (!cfg) throw new Error(`no license config for ${state}. Configured: ${Object.keys(STATE_CONFIGS).join(', ')}`);
  if (cfg.mode === 'socrata') return fetchSocrata(cfg, key, opts);
  if (cfg.mode === 'csv') return fetchCsv(cfg, key, opts);
  throw new Error(`unknown mode ${cfg.mode}`);
}

module.exports = { syncLicenses, fetchSocrata, mapRow, tidyName, STATE_CONFIGS };

// CLI: node socrata-licenses.cjs WA --limit 25 [--trade electrical] [--all]
if (require.main === module) {
  (async () => {
    const argv = process.argv.slice(2);
    const state = argv[0] || 'WA';
    const limIdx = argv.indexOf('--limit'); const limit = limIdx !== -1 ? parseInt(argv[limIdx + 1], 10) : 25;
    const trIdx = argv.indexOf('--trade'); const trade = trIdx !== -1 ? argv[trIdx + 1] : null;
    const leads = await syncLicenses(state, { activeOnly: !argv.includes('--all'), limit, trade });
    console.log(`${leads.length} ${state} licensed leads:`);
    for (const l of leads) console.log(`  ${(l.business_name || l.contact_name || '').slice(0, 30).padEnd(31)} | ${(l.contact_name || '').padEnd(20)} | ${(l.phone || 'no-phone').padEnd(14)} | ${(l.city || '') + ',' + l.state} | ${l.industry || ''} [${l.license_status || ''}]`);
  })().catch((e) => { console.error('FATAL:', e.message); process.exit(1); });
}
