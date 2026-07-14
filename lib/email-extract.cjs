'use strict';
/**
 * lib/email-extract.cjs — obfuscation-decoding email extractor. Pure Node, zero dependencies.
 *
 * Most small-business emails are obfuscated to dodge naive scrapers. A plain `mailto:` + text regex
 * misses the majority. This decodes the common tricks so you recover the same addresses a paid data
 * provider would sell you, for $0:
 *   - Cloudflare email-protection (data-cfemail / /cdn-cgi/l/email-protection#<hex>)
 *   - HTML entities (&commat; = @, &period; = ., &#x40;, &#64;, …)
 *   - "name [at] domain [dot] com" / "(at)" / " at " / "{dot}"
 *   - mailto: with percent/entity encoding · JSON-LD "email":"..."
 * It also filters structural junk (crawler/bot contacts, placeholder addresses, phone-as-domain,
 * hex-hash local parts, image filenames) so the output is a clean, sendable pool.
 */

const EMAIL_RE = /[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/g;
// Name-based junk (crawler/bot contacts, platform/CDN noise, placeholders, image files, fake TLDs).
const JUNK_EMAIL = /(example|sentry|wixpress|godaddy|squarespace|\.png|\.jpe?g|\.gif|\.svg|\.webp|@2x|yourdomain|domain\.com|email\.com|sentry\.io|wix\.com|cloudflare|schema\.org|w3\.org|googleapis|gstatic|jquery|bootstrap|claudebot|gptbot|bingbot|googlebot|ccbot|bytespider|ahrefsbot|semrushbot|petalbot|amazonbot|applebot|@(anthropic|openai)\.com|yextpages|glossgenius|mindbodyonline|booksy|vagaro|square\.site|acuityscheduling|yourname|your-name|firstname|lastname|yourbusiness|yourcompany|@company\.com|\.(hero|our|home|local|test|invalid|example)$)/i;

/** Structural junk-email guards — the patterns a name-regex can't catch. */
function isPhoneDomain(email) {
  if (typeof email !== 'string' || !email) return false;
  const at = email.lastIndexOf('@');
  if (at < 0 || at >= email.length - 1) return false;
  return /^\d[\d.\-]{5,}\./.test(email.slice(at + 1)); // domain begins with a phone number
}
function isWwwDomain(email) {
  return typeof email === 'string' && /@www\./i.test(email); // scraper glued a URL's www. into the domain
}
function isHashLocalPart(email) {
  return typeof email === 'string' && /^[0-9a-f]{24,}@/i.test(email); // 24+ hex local part = a directory hash, not an inbox
}
function isJunkEmail(email) {
  return !email || typeof email !== 'string' ||
    JUNK_EMAIL.test(email) || isPhoneDomain(email) || isWwwDomain(email) || isHashLocalPart(email);
}

/** Cloudflare email-protection decoder. cf = hex string; first byte is the XOR key. */
function decodeCfEmail(cf) {
  try {
    const r = parseInt(cf.substr(0, 2), 16);
    let out = '';
    for (let i = 2; i < cf.length; i += 2) out += String.fromCharCode(parseInt(cf.substr(i, 2), 16) ^ r);
    return out;
  } catch (_) { return ''; }
}

function decodeEntities(s) {
  return String(s)
    .replace(/\\u([0-9a-fA-F]{4})/g, (_, h) => { try { return String.fromCharCode(parseInt(h, 16)); } catch { return _; } })
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => { try { return String.fromCodePoint(parseInt(h, 16)); } catch { return _; } })
    .replace(/&#(\d+);/g, (_, d) => { try { return String.fromCodePoint(parseInt(d, 10)); } catch { return _; } })
    .replace(/&(amp|lt|gt|quot|apos|period|commat);/gi, (m, n) => ({ amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", period: '.', commat: '@' }[n.toLowerCase()] || m));
}

// "name [at] domain [dot] com" / "(at)" / " at " / "{dot}" → real address
const OBFUSCATED_RE = /([a-z0-9._%+\-]+)\s*(?:\[|\(|\{)?\s*(?:@|\bat\b)\s*(?:\]|\)|\})?\s*([a-z0-9.\-]+)\s*(?:\[|\(|\{)?\s*(?:\.|\bdot\b)\s*(?:\]|\)|\})?\s*([a-z]{2,})/gi;

/** Pull every plausible email out of one HTML string, decoding obfuscation. */
function extractEmailsFromHtml(html) {
  if (!html) return [];
  const found = new Set();
  const add = (e) => { if (!e) return; e = e.toLowerCase().trim().replace(/\.$/, ''); if (e.length <= 60 && !isJunkEmail(e) && EMAIL_RE.test(e)) found.add(e); EMAIL_RE.lastIndex = 0; };

  // 1. Cloudflare data-cfemail + /cdn-cgi/l/email-protection#<hex>
  for (const m of html.matchAll(/data-cfemail="([0-9a-fA-F]+)"/g)) add(decodeCfEmail(m[1]));
  for (const m of html.matchAll(/email-protection#([0-9a-fA-F]+)/g)) add(decodeCfEmail(m[1]));
  // 2. mailto: links (decode entities/percent first)
  for (const m of html.matchAll(/mailto:([^"'>?\s]+)/gi)) { try { add(decodeEntities(decodeURIComponent(m[1]))); } catch { add(decodeEntities(m[1])); } }
  // 3. JSON-LD / inline "email": "..."
  for (const m of html.matchAll(/"email"\s*:\s*"([^"]+)"/gi)) add(decodeEntities(m[1]).replace(/^mailto:/i, ''));
  // 4. entity-decoded plain text
  const decoded = decodeEntities(html);
  for (const m of (decoded.match(EMAIL_RE) || [])) add(m);
  // 5. "[at]"/"[dot]" obfuscation on the text-only version
  const text = decoded.replace(/<[^>]+>/g, ' ');
  for (const m of text.matchAll(OBFUSCATED_RE)) add(`${m[1]}@${m[2]}.${m[3]}`);
  return [...found];
}

/** bareEmail(s) — normalizer that extracts the address from a "Name <addr@x.com>" wrapper. */
function bareEmail(s) {
  s = String(s || '').toLowerCase().trim();
  const m = s.match(/<([^>]+)>/);
  return (m ? m[1] : s).trim();
}

module.exports = { extractEmailsFromHtml, decodeCfEmail, decodeEntities, JUNK_EMAIL, EMAIL_RE, bareEmail, isPhoneDomain, isWwwDomain, isHashLocalPart, isJunkEmail };

// CLI self-test / quick check: node lib/email-extract.cjs < some.html
if (require.main === module) {
  const chunks = [];
  process.stdin.on('data', (c) => chunks.push(c));
  process.stdin.on('end', () => {
    const html = Buffer.concat(chunks).toString('utf8') ||
      '<a href="mailto:hello&#64;example-biz.com">mail</a> or reach jane [at] example-biz [dot] com';
    console.log(extractEmailsFromHtml(html).join('\n') || '(no emails found)');
  });
  if (process.stdin.isTTY) process.stdin.emit('end');
}
