'use strict';

/**
 * Apollo Replacement — B2B Contact Enrichment Toolkit
 *
 * Self-hosted contact enrichment: given company domains and names, generates
 * standard B2B email-pattern candidates, validates MX records, and optionally
 * probes SMTP to rank likely decision-maker addresses.
 *
 * Usage:
 *   node enrich.cjs --in contacts.csv [--out enriched.csv] [--smtp] [--concurrency 5]
 *   node enrich.cjs --domain example.com --first Jane --last Doe [--smtp]
 *   node enrich.cjs --help
 */

const fs = require('fs');
const path = require('path');
const dns = require('dns').promises;
const net = require('net');
const readline = require('readline');
const process = require('process');

const HEADERS_MAP = {
  domain: 'domain',
  website: 'domain',
  company_domain: 'domain',
  url: 'domain',
  web: 'domain',
  first_name: 'first',
  first: 'first',
  given_name: 'first',
  last_name: 'last',
  last: 'last',
  family_name: 'last',
  surname: 'last',
  full_name: 'full_name',
  name: 'full_name',
  company: 'company',
  title: 'title',
  position: 'title',
  job_title: 'title',
};

const TRANSIENT_DNS_CODES = new Set(['ETIMEOUT', 'ESERVFAIL', 'ECONNREFUSED', 'EAI_AGAIN']);
const SMTP_ACCEPT_CODES = new Set([250, 251]);
const SMTP_REJECT_CODES = new Set([550, 551, 552, 553, 554]);
const SMTP_TEMP_CODES = new Set([421, 450, 451, 452]);

const EMAIL_SYNTAX_RE = /^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/i;

function createRunContext() {
  return {
    mxCache: new Map(),
    mxPending: new Map(),
    domainLastSmtpProbe: new Map(),
    domainSmtpChains: new Map(),
    catchAllCache: new Map(),
  };
}

function normalizeDomain(str) {
  if (!str) return '';
  let d = String(str).toLowerCase().trim();
  if (!d) return '';
  d = d.replace(/^https?:\/\//, '');
  d = d.replace(/^www\./, '');
  d = d.split('/')[0];
  d = d.split('?')[0];
  d = d.split('#')[0];
  d = d.split(':')[0];
  d = d.replace(/\.+$/, '');
  return d;
}

function sanitizeNamePart(str) {
  if (!str) return '';
  return String(str)
    .toLowerCase()
    .trim()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]/g, '');
}

function splitFullName(fullName) {
  const parts = String(fullName || '')
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  if (parts.length === 0) return { first: '', last: '' };
  if (parts.length === 1) return { first: parts[0], last: '' };
  return { first: parts[0], last: parts[parts.length - 1] };
}

function parseCsvLine(line) {
  const result = [];
  let current = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    if (char === '"') {
      if (inQuotes && line[i + 1] === '"') {
        current += '"';
        i++;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (char === ',' && !inQuotes) {
      result.push(current);
      current = '';
    } else {
      current += char;
    }
  }
  result.push(current);
  return result;
}

function csvEscape(val) {
  if (val === null || val === undefined) return '';
  const str = String(val);
  if (/[",\r\n]/.test(str)) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function createSemaphore(max) {
  const limit = Math.max(1, max);
  let active = 0;
  const waiters = [];

  return {
    async acquire() {
      if (active < limit) {
        active++;
        return;
      }
      await new Promise((resolve) => waiters.push(resolve));
      active++;
    },
    release() {
      active--;
      if (waiters.length > 0) {
        const next = waiters.shift();
        next();
      }
    },
  };
}

function permute(first, last, domain) {
  first = sanitizeNamePart(first);
  last = sanitizeNamePart(last);
  domain = normalizeDomain(domain);

  const candidates = [];
  const seen = new Set();

  const add = (local, pattern, type) => {
    if (!local || !domain) return;
    const email = `${local}@${domain}`;
    if (seen.has(email)) return;
    seen.add(email);
    candidates.push({ email, pattern, type });
  };

  if (first && last) {
    add(`${first}.${last}`, 'first.last', 'person');
    add(`${first[0]}${last}`, 'flast', 'person');
    add(`${first}${last}`, 'firstlast', 'person');
    add(`${first[0]}.${last}`, 'f.last', 'person');
    add(`${first}${last[0]}`, 'firstl', 'person');
    add(first, 'first', 'person');
    add(last, 'last', 'person');
    add(`${last}.${first}`, 'last.first', 'person');
    add(`${first}_${last}`, 'first_last', 'person');
    add(`${first}-${last}`, 'first-last', 'person');
  } else if (first || last) {
    if (first) add(first, 'first', 'person');
    if (last) add(last, 'last', 'person');
  } else {
    add('first', 'first', 'role');
    add('info', 'info', 'role');
    add('contact', 'contact', 'role');
    add('hello', 'hello', 'role');
  }

  return candidates;
}

function isValidEmailSyntax(email) {
  if (!email || email.length > 254) return false;
  const at = email.lastIndexOf('@');
  if (at <= 0 || at === email.length - 1) return false;
  const local = email.slice(0, at);
  if (local.length > 64) return false;
  return EMAIL_SYNTAX_RE.test(email);
}

async function verifyDomainMx(domain, retriesLeft = 1) {
  const normalized = normalizeDomain(domain);
  if (!normalized) {
    return { valid: false, status: 'invalid_domain', host: null, hosts: [] };
  }

  try {
    const records = await dns.resolveMx(normalized);
    if (!records || records.length === 0) {
      return { valid: false, status: 'no_mx', host: null, hosts: [] };
    }
    records.sort((a, b) => a.priority - b.priority);
    const hosts = records.map((r) => String(r.exchange).replace(/\.$/, '').toLowerCase());
    return { valid: true, status: 'valid', host: hosts[0], hosts };
  } catch (err) {
    const code = err && err.code ? err.code : '';
    if (code === 'ENOTFOUND' || code === 'ENODATA') {
      return { valid: false, status: 'no_mx', host: null, hosts: [] };
    }
    if (TRANSIENT_DNS_CODES.has(code) && retriesLeft > 0) {
      await sleep(400);
      return verifyDomainMx(normalized, retriesLeft - 1);
    }
    if (TRANSIENT_DNS_CODES.has(code)) {
      return { valid: false, status: 'unknown', host: null, hosts: [] };
    }
    return { valid: false, status: 'unknown', host: null, hosts: [] };
  }
}

async function getDomainMx(domain, mxSemaphore, ctx) {
  const normalized = normalizeDomain(domain);
  if (!normalized) {
    return { valid: false, status: 'invalid_domain', host: null, hosts: [] };
  }

  if (ctx.mxCache.has(normalized)) {
    return ctx.mxCache.get(normalized);
  }
  if (ctx.mxPending.has(normalized)) {
    return ctx.mxPending.get(normalized);
  }

  const lookupPromise = (async () => {
    if (mxSemaphore) await mxSemaphore.acquire();
    try {
      const result = await verifyDomainMx(normalized);
      ctx.mxCache.set(normalized, result);
      return result;
    } finally {
      if (mxSemaphore) mxSemaphore.release();
      ctx.mxPending.delete(normalized);
    }
  })();

  ctx.mxPending.set(normalized, lookupPromise);
  return lookupPromise;
}

function smtpProbe(mxHost, email) {
  return new Promise((resolve) => {
    let settled = false;
    let phase = 'connect';
    let buffer = '';
    let socket;

    const finish = (status) => {
      if (settled) return;
      settled = true;
      clearTimeout(hardTimer);
      try {
        if (socket && !socket.destroyed) {
          socket.write('QUIT\r\n');
        }
      } catch (_) {
        // ignore cleanup write failures
      }
      try {
        if (socket && !socket.destroyed) {
          socket.destroy();
        }
      } catch (_) {
        // ignore cleanup destroy failures
      }
      resolve(status);
    };

    const hardTimer = setTimeout(() => finish('unknown'), 8000);

    try {
      socket = net.createConnection({ host: mxHost, port: 25, timeout: 8000 });
    } catch (_) {
      finish('unknown');
      return;
    }

    socket.setEncoding('utf8');
    socket.setTimeout(8000);

    const handleLines = (lines) => {
      for (const rawLine of lines) {
        const line = rawLine.trim();
        if (!line) continue;
        if (line.length >= 4 && line[3] === '-') continue;

        const code = parseInt(line.slice(0, 3), 10);
        if (Number.isNaN(code)) continue;

        if (phase === 'connect' && code === 220) {
          socket.write('EHLO localhost\r\n');
          phase = 'ehlo';
          continue;
        }

        if (phase === 'ehlo') {
          if (code === 250) {
            socket.write('MAIL FROM:<>\r\n');
            phase = 'mailfrom';
            continue;
          }
          if (code >= 500 && code < 600) {
            socket.write('HELO localhost\r\n');
            phase = 'helo';
            continue;
          }
          if (code >= 400) {
            finish('unknown');
            return;
          }
        }

        if (phase === 'helo') {
          if (code === 250) {
            socket.write('MAIL FROM:<>\r\n');
            phase = 'mailfrom';
            continue;
          }
          if (code >= 400) {
            finish('unknown');
            return;
          }
        }

        if (phase === 'mailfrom' && code === 250) {
          socket.write(`RCPT TO:<${email}>\r\n`);
          phase = 'rcpt';
          continue;
        }

        if (phase === 'rcpt') {
          if (SMTP_ACCEPT_CODES.has(code)) {
            finish('deliverable');
            return;
          }
          if (SMTP_REJECT_CODES.has(code)) {
            finish('rejected');
            return;
          }
          if (SMTP_TEMP_CODES.has(code)) {
            finish('unknown');
            return;
          }
          finish('unknown');
          return;
        }

        if (code >= 400 && phase !== 'rcpt') {
          finish('unknown');
          return;
        }
      }
    };

    socket.on('data', (chunk) => {
      buffer += chunk;
      const parts = buffer.split(/\r?\n/);
      buffer = parts.pop() || '';
      handleLines(parts);
    });

    socket.on('error', () => finish('unknown'));
    socket.on('timeout', () => finish('unknown'));
    socket.on('close', () => {
      if (!settled) finish('unknown');
    });
  });
}

async function withDomainSmtpSlot(domain, fn, ctx) {
  const key = normalizeDomain(domain);
  const prior = ctx.domainSmtpChains.get(key) || Promise.resolve();
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const chained = prior.then(() => gate);
  ctx.domainSmtpChains.set(
    key,
    chained.catch(() => {})
  );

  await prior.catch(() => {});

  try {
    const now = Date.now();
    const last = ctx.domainLastSmtpProbe.get(key) || 0;
    const delay = Math.max(0, last + 2000 - now);
    if (delay > 0) await sleep(delay);
    ctx.domainLastSmtpProbe.set(key, Date.now());
    return await fn();
  } finally {
    release();
  }
}

async function probeSmtp(domain, mxHost, email, ctx) {
  if (!mxHost || !email) return 'unknown';
  try {
    return await withDomainSmtpSlot(domain, () => smtpProbe(mxHost, email), ctx);
  } catch (_) {
    return 'unknown';
  }
}

async function detectCatchAll(domain, mxHost, ctx) {
  const key = normalizeDomain(domain);
  if (ctx.catchAllCache.has(key)) {
    return ctx.catchAllCache.get(key);
  }
  if (!mxHost) {
    ctx.catchAllCache.set(key, null);
    return null;
  }

  const bogusLocal = `no-deliver-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
  const bogusEmail = `${bogusLocal}@${key}`;
  let result = 'unknown';
  try {
    result = await probeSmtp(key, mxHost, bogusEmail, ctx);
  } catch (_) {
    result = 'unknown';
  }

  const isCatchAll = result === 'deliverable';
  ctx.catchAllCache.set(key, isCatchAll);
  return isCatchAll;
}

function scoreCandidate(candidate, mxResult, smtpResult) {
  let score = 0;

  if (candidate.type === 'person') {
    if (candidate.pattern === 'first.last' || candidate.pattern === 'flast') {
      score = 50;
    } else {
      score = 40;
    }
  } else {
    score = 20;
  }

  if (mxResult && mxResult.valid) {
    score += 30;
  } else if (mxResult && mxResult.status === 'unknown') {
    score += 10;
  }

  if (smtpResult === 'deliverable') {
    score += 20;
  } else if (smtpResult === 'catch_all') {
    score += 5;
  } else if (smtpResult === 'rejected') {
    score = 0;
  }

  score = Math.min(100, Math.max(0, score));

  let grade = 'D';
  if (score >= 90) grade = 'A';
  else if (score >= 75) grade = 'B';
  else if (score >= 60) grade = 'C';

  return { score, grade };
}

function buildInputName(first, last, fullName) {
  const f = (first || '').trim();
  const l = (last || '').trim();
  if (f || l) return `${f} ${l}`.trim();
  return (fullName || '').trim();
}

function resolveNames(row) {
  let first = row.first || '';
  let last = row.last || '';
  const fullName = row.full_name || '';

  if ((!first || !last) && fullName) {
    const split = splitFullName(fullName);
    if (!first) first = split.first;
    if (!last) last = split.last;
  }

  return { first, last, fullName };
}

function rowStatusMessage(result) {
  if (result.row_status === 'missing_domain') return 'missing domain';
  if (result.row_status === 'no_candidates') return 'no candidates';
  if (result.row_status === 'no_mx') return 'no MX';
  if (result.row_status === 'mx_unknown') return 'MX lookup inconclusive';
  if (result.row_status === 'syntax_filtered') return 'all candidates failed syntax check';
  if (result.row_status === 'all_rejected') return 'all candidates rejected by SMTP';
  if (result.smtp_status === 'deliverable') return 'SMTP deliverable';
  if (result.smtp_status === 'catch_all') return 'catch-all domain (unverified)';
  if (result.best_email) return 'plausible candidate';
  return 'no match';
}

function isPlausibleResult(result) {
  if (!result.best_email) return false;
  if (result.smtp_status === 'rejected') return false;
  if (result.confidence_score <= 0) return false;
  return true;
}

async function processRow(row, mxSemaphore, options, ctx) {
  const title = row.title || '';
  const domain = normalizeDomain(row.domain);
  const { first, last, fullName } = resolveNames(row);
  const inputName = buildInputName(first, last, fullName);

  const emptyResult = (overrides) => ({
    input_name: inputName,
    domain,
    best_email: '',
    pattern: '',
    mx_valid: false,
    smtp_status: 'skipped',
    confidence_score: 0,
    grade: 'D',
    title,
    other_candidates: '',
    row_status: 'error',
    ...overrides,
  });

  if (!domain) {
    return emptyResult({ row_status: 'missing_domain', smtp_status: 'skipped' });
  }

  const candidates = permute(first, last, domain);
  if (candidates.length === 0) {
    return emptyResult({ row_status: 'no_candidates' });
  }

  let mxResult;
  try {
    mxResult = await getDomainMx(domain, mxSemaphore, ctx);
  } catch (_) {
    mxResult = { valid: false, status: 'unknown', host: null, hosts: [] };
  }

  if (mxResult.status === 'no_mx') {
    return emptyResult({
      row_status: 'no_mx',
      mx_valid: false,
      smtp_status: 'skipped',
    });
  }

  const syntaxValid = candidates.filter((c) => isValidEmailSyntax(c.email));
  if (syntaxValid.length === 0) {
    return emptyResult({ row_status: 'syntax_filtered' });
  }

  const smtpEnabled = Boolean(options.smtp);
  const smtpStatuses = new Map();
  let domainCatchAll = null;

  if (smtpEnabled && mxResult.host) {
    try {
      domainCatchAll = await detectCatchAll(domain, mxResult.host, ctx);
    } catch (_) {
      domainCatchAll = null;
    }
  }

  if (smtpEnabled && mxResult.host && domainCatchAll !== true) {
    for (const candidate of syntaxValid) {
      if (candidate.type === 'role') continue;
      let status = 'unknown';
      try {
        status = await probeSmtp(domain, mxResult.host, candidate.email, ctx);
      } catch (_) {
        status = 'unknown';
      }
      smtpStatuses.set(candidate.email, status);
      if (status === 'deliverable') {
        break;
      }
    }
  } else if (smtpEnabled && domainCatchAll === true) {
    for (const candidate of syntaxValid) {
      smtpStatuses.set(candidate.email, 'catch_all');
    }
  }

  const scored = syntaxValid.map((candidate) => {
    let smtpStatus = 'skipped';
    if (smtpEnabled) {
      smtpStatus = smtpStatuses.get(candidate.email) || 'unknown';
      if (domainCatchAll === true && smtpStatus !== 'catch_all') {
        smtpStatus = 'catch_all';
      }
    }

    const { score, grade } = scoreCandidate(candidate, mxResult, smtpStatus);
    return {
      email: candidate.email,
      pattern: candidate.pattern,
      type: candidate.type,
      mx_valid: Boolean(mxResult.valid),
      smtp_status: smtpStatus,
      confidence_score: score,
      grade,
    };
  });

  scored.sort((a, b) => {
    if (b.confidence_score !== a.confidence_score) {
      return b.confidence_score - a.confidence_score;
    }
    if (a.type !== b.type) return a.type === 'person' ? -1 : 1;
    return 0;
  });

  const viable = scored.filter(
    (c) => c.confidence_score > 0 && c.smtp_status !== 'rejected'
  );
  const pool = viable.length > 0 ? viable : scored.filter((c) => c.smtp_status !== 'rejected');
  const best = pool[0] || null;

  if (!best) {
    return emptyResult({
      row_status: mxResult.status === 'unknown' ? 'mx_unknown' : 'all_rejected',
      mx_valid: Boolean(mxResult.valid),
      smtp_status: smtpEnabled ? 'rejected' : 'skipped',
    });
  }

  const others = pool
    .slice(1)
    .filter((c) => c.email !== best.email)
    .map((c) => c.email)
    .join(';');

  let rowStatus = 'ok';
  if (mxResult.status === 'unknown') rowStatus = 'mx_unknown';
  else if (best.smtp_status === 'catch_all') rowStatus = 'catch_all';
  else if (best.smtp_status === 'deliverable') rowStatus = 'deliverable';

  return {
    input_name: inputName,
    domain,
    best_email: best.email,
    pattern: best.pattern,
    mx_valid: best.mx_valid,
    smtp_status: best.smtp_status,
    confidence_score: best.confidence_score,
    grade: best.grade,
    title,
    other_candidates: others,
    row_status: rowStatus,
  };
}

async function loadCsvRows(inputPath) {
  if (!fs.existsSync(inputPath)) {
    throw new Error(`Input file not found: ${inputPath}`);
  }

  const rows = [];
  const stream = fs.createReadStream(inputPath, { encoding: 'utf8' });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });

  let headers = [];
  let isHeader = true;

  for await (const rawLine of rl) {
    const line = rawLine.replace(/^\uFEFF/, '');
    if (!line.trim()) continue;

    const columns = parseCsvLine(line);

    if (isHeader) {
      headers = columns.map((h) =>
        h
          .toLowerCase()
          .trim()
          .replace(/\s+/g, '_')
          .replace(/[^\w_]/g, '')
      );
      isHeader = false;
      continue;
    }

    const row = {};
    for (let i = 0; i < headers.length; i++) {
      const mapped = HEADERS_MAP[headers[i]];
      if (mapped) {
        row[mapped] = columns[i] !== undefined ? String(columns[i]).trim() : '';
      }
    }
    rows.push(row);
  }

  return rows;
}

async function run(options = {}) {
  const concurrency = Math.min(50, Math.max(1, parseInt(options.concurrency, 10) || 5));
  const smtp = Boolean(options.smtp);

  const now = new Date();
  const dateStr = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}`;
  const outPath = options.out || path.join(process.cwd(), `enriched-${dateStr}.csv`);

  const mxSemaphore = createSemaphore(concurrency);
  const ctx = createRunContext();

  const headerLine =
    'input_name,domain,best_email,pattern,mx_valid,smtp_status,confidence_score,grade,title,other_candidates\n';
  fs.writeFileSync(outPath, headerLine, 'utf8');

  const writeRow = (row) => {
    const line = [
      row.input_name,
      row.domain,
      row.best_email,
      row.pattern,
      row.mx_valid,
      row.smtp_status,
      row.confidence_score,
      row.grade,
      row.title,
      row.other_candidates,
    ]
      .map(csvEscape)
      .join(',');
    fs.appendFileSync(outPath, `${line}\n`, 'utf8');
  };

  let rows = [];
  if (options.domain) {
    rows = [
      {
        domain: options.domain,
        first: options.first || '',
        last: options.last || '',
        title: options.title || '',
      },
    ];
  } else if (options.in) {
    rows = await loadCsvRows(options.in);
  } else {
    throw new Error('Must provide either --in <file> or --domain <domain>');
  }

  let totalRows = 0;
  let plausibleCount = 0;
  let highGradeCount = 0;
  let rowIndex = 0;

  const worker = async () => {
    while (true) {
      const idx = rowIndex++;
      if (idx >= rows.length) return;
      const sourceRow = rows[idx];

      let result;
      try {
        result = await processRow(sourceRow, mxSemaphore, { smtp, concurrency }, ctx);
      } catch (_) {
        result = {
          input_name: buildInputName(sourceRow.first, sourceRow.last, sourceRow.full_name),
          domain: normalizeDomain(sourceRow.domain),
          best_email: '',
          pattern: '',
          mx_valid: false,
          smtp_status: 'error',
          confidence_score: 0,
          grade: 'D',
          title: sourceRow.title || '',
          other_candidates: '',
          row_status: 'error',
        };
      }

      writeRow(result);
      totalRows++;

      if (isPlausibleResult(result)) plausibleCount++;
      if (result.grade === 'A' || result.grade === 'B') highGradeCount++;

      const status = rowStatusMessage(result);
      const emailPart = result.best_email ? result.best_email : '(none)';
      console.log(
        `[${totalRows}/${rows.length}] ${result.domain || '-'} | ${result.input_name || '-'} | ${emailPart} | ${status}`
      );
    }
  };

  const workers = [];
  for (let i = 0; i < concurrency; i++) {
    workers.push(worker());
  }
  await Promise.all(workers);

  console.log(
    `\nSummary: ${totalRows} rows, ${plausibleCount} with deliverable/plausible email, ${highGradeCount} graded A/B`
  );
  console.log(`Results saved to: ${outPath}`);

  return {
    totalRows,
    plausibleCount,
    highGradeCount,
    outPath,
  };
}

function showHelp() {
  console.log(`
Apollo Replacement — B2B Contact Enrichment Toolkit

Usage:
  node enrich.cjs --in contacts.csv [--out enriched.csv] [--smtp] [--concurrency 5]
  node enrich.cjs --domain example.com --first Jane --last Doe [--smtp]

Options:
  --in <path>         Input CSV path (flexible headers: domain, first_name, last_name, etc.)
  --out <path>        Output CSV path (default: enriched-YYYYMMDD.csv in cwd)
  --domain <domain>   Single lookup domain
  --first <name>      Single lookup first name
  --last <name>       Single lookup last name
  --smtp              Enable SMTP RCPT probing (slower; verifies deliverability when allowed)
  --concurrency <n>   Parallel row workers / MX lookup cap (default: 5, max: 50)
  --help              Show this help
`);
}

async function main() {
  const args = process.argv.slice(2);
  const options = {
    in: null,
    out: null,
    domain: null,
    first: null,
    last: null,
    smtp: false,
    concurrency: 5,
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    switch (arg) {
      case '--in':
        options.in = args[++i];
        break;
      case '--out':
        options.out = args[++i];
        break;
      case '--domain':
        options.domain = args[++i];
        break;
      case '--first':
        options.first = args[++i];
        break;
      case '--last':
        options.last = args[++i];
        break;
      case '--smtp':
        options.smtp = true;
        break;
      case '--concurrency':
        options.concurrency = args[++i];
        break;
      case '--help':
      case '-h':
        showHelp();
        process.exit(0);
        break;
      default:
        if (arg.startsWith('--')) {
          console.error(`Unknown option: ${arg}`);
          showHelp();
          process.exit(1);
        }
    }
  }

  if (!options.in && !options.domain) {
    console.error('Error: provide --in <csv> or --domain <domain>');
    showHelp();
    process.exit(1);
  }

  if (options.in && options.domain) {
    console.error('Error: use either --in or --domain, not both');
    process.exit(1);
  }

  try {
    await run(options);
  } catch (err) {
    console.error(`Fatal: ${err && err.message ? err.message : String(err)}`);
    process.exit(1);
  }
}

if (require.main === module) {
  main();
}

module.exports = {
  permute,
  verifyDomainMx,
  scoreCandidate,
  run,
};
