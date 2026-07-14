'use strict';

/**
 * lib/browser.cjs — shared Puppeteer launcher + helpers.
 *
 * Used by all the social scrapers. Self-contained — no external dependencies
 * other than puppeteer.
 *
 * Highlights:
 *   - rotateUserAgent: picks a current desktop UA per request
 *   - cookieJarPath: persists logged-in cookies between runs (./data/cookies/)
 *   - withRateLimit: 1.5s default between requests to same domain
 *   - safeReadJsonFromPage: pulls JSON embedded in <script> tags
 *   - launchViaBrowserbase: optional residential-IP fallback
 */

const fs = require('fs');
const path = require('path');

let puppeteer;
try { puppeteer = require('puppeteer'); }
catch (_) { puppeteer = null; }

const DEFAULT_RATE_MS = parseInt(process.env.SOCIAL_RATE_MS || '1500', 10);

// data/ is created at module load so scrapers can save without ceremony
const DATA_DIR = path.join(__dirname, '..', 'data');
const COOKIE_DIR = path.join(DATA_DIR, 'cookies');
try { fs.mkdirSync(COOKIE_DIR, { recursive: true }); } catch (_) {}

const UA_POOL = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
];

function rotateUserAgent() {
  return UA_POOL[Math.floor(Math.random() * UA_POOL.length)];
}

function cookieJarPath(platform) {
  return path.join(COOKIE_DIR, `${platform}.json`);
}

async function loadCookies(page, platform) {
  const jar = cookieJarPath(platform);
  if (!fs.existsSync(jar)) return false;
  try {
    const cookies = JSON.parse(fs.readFileSync(jar, 'utf8'));
    if (Array.isArray(cookies) && cookies.length) {
      await page.setCookie(...cookies);
      return true;
    }
  } catch (_) {}
  return false;
}

async function saveCookies(page, platform) {
  try {
    const cookies = await page.cookies();
    fs.writeFileSync(cookieJarPath(platform), JSON.stringify(cookies, null, 2));
  } catch (_) {}
}

const _lastHit = new Map();
async function withRateLimit(domain, fn) {
  const last = _lastHit.get(domain) || 0;
  const wait = Math.max(0, DEFAULT_RATE_MS - (Date.now() - last));
  if (wait > 0) await new Promise(r => setTimeout(r, wait));
  _lastHit.set(domain, Date.now());
  return fn();
}

async function launchBrowser({ headless = 'new', proxy = null } = {}) {
  if (!puppeteer) {
    throw new Error('puppeteer is not installed. Run: npm install');
  }
  const args = [
    '--no-sandbox',
    '--disable-setuid-sandbox',
    '--disable-blink-features=AutomationControlled',
    '--disable-features=IsolateOrigins,site-per-process',
    `--user-agent=${rotateUserAgent()}`,
  ];
  if (proxy) args.push(`--proxy-server=${proxy}`);
  return puppeteer.launch({ headless, args });
}

async function openPage(browser, platform) {
  const page = await browser.newPage();
  await page.setViewport({ width: 1366, height: 900 });
  await page.setUserAgent(rotateUserAgent());
  await page.setExtraHTTPHeaders({ 'Accept-Language': 'en-US,en;q=0.9' });
  if (platform) await loadCookies(page, platform);
  return page;
}

async function safeReadJsonFromPage(page, regex) {
  try {
    return await page.evaluate((reSrc) => {
      const re = new RegExp(reSrc, 'i');
      const scripts = Array.from(document.querySelectorAll('script'));
      for (const s of scripts) {
        const m = (s.textContent || '').match(re);
        if (m) {
          try { return JSON.parse(m[1]); } catch (_) {}
        }
      }
      return null;
    }, regex);
  } catch (_) { return null; }
}

function browserbaseEndpoint() {
  if (process.env.USE_BROWSERBASE !== '1') return null;
  if (!process.env.BROWSERBASE_API_KEY) return null;
  return `wss://connect.browserbase.com?apiKey=${process.env.BROWSERBASE_API_KEY}&projectId=${process.env.BROWSERBASE_PROJECT_ID || ''}`;
}

async function launchViaBrowserbase() {
  if (!puppeteer) throw new Error('puppeteer is not installed');
  const ep = browserbaseEndpoint();
  if (!ep) throw new Error('Browserbase not configured');
  return puppeteer.connect({ browserWSEndpoint: ep });
}

// Convenient wrapper: choose Browserbase if configured, else local
async function withBrowser(fn) {
  const useBB = process.env.USE_BROWSERBASE === '1';
  const browser = useBB ? await launchViaBrowserbase() : await launchBrowser();
  try { return await fn(browser); }
  finally { try { useBB ? browser.disconnect() : await browser.close(); } catch (_) {} }
}

// Simple JSON save helper for scrapers
function saveJSON(filePath, data) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
}

function loadEnv() {
  const envPath = path.join(__dirname, '..', '.env');
  if (!fs.existsSync(envPath)) return;
  for (const line of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
  }
}

const log = {
  info: (...a) => console.log('[info]', ...a),
  warn: (...a) => console.warn('[warn]', ...a),
  error: (...a) => console.error('[error]', ...a),
};

module.exports = {
  launchBrowser,
  launchViaBrowserbase,
  withBrowser,
  openPage,
  withRateLimit,
  rotateUserAgent,
  loadCookies,
  saveCookies,
  cookieJarPath,
  safeReadJsonFromPage,
  browserbaseEndpoint,
  saveJSON,
  loadEnv,
  log,
  DATA_DIR,
};
