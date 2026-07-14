'use strict';
/**
 * personalized-opener.cjs — write a 1:1 cold-email FIRST LINE from REAL scraped facts only.
 *
 * Added 2026-06-30. The pipeline already scrapes each business's Google rating, review count,
 * category and city — this turns those into an opener that feels hand-written, so your email
 * reads 1:1 instead of mail-merged. ANTI-FABRICATION: it only ever cites numbers that were
 * actually scraped (rating / review count). If a fact is missing, the line stays observational
 * rather than inventing one — so you never send "your 47 5-star reviews" to a business that
 * has none. Deterministic + offline (no API, no LLM).
 *
 *   const { openerFor } = require('./personalized-opener.cjs');
 *   openerFor(lead) -> string   // ready to drop in as the email's first sentence
 */
function cityOf(lead) {
  if (lead.city) return String(lead.city).replace(/\s*\b[A-Z]{2}\b\s*$/, '').trim();
  // From a free-form address, the city is the words right before the 2-letter state code, after a comma.
  if (lead.address) { const m = String(lead.address).match(/,\s*([A-Za-z][A-Za-z .'-]+?)\s+[A-Z]{2}\b/); if (m) return m[1].trim(); }
  return '';
}

function openerFor(lead) {
  const cat = String(lead.category || lead.industry || 'local business').toLowerCase().replace(/\.$/, '');
  const city = cityOf(lead);
  const loc = city ? ` in ${city}` : '';
  const r = typeof lead.rating === 'number' ? lead.rating : null;
  const rev = typeof lead.reviews === 'number' ? lead.reviews : null;

  if (r && rev && rev >= 10)
    return `With a ${r}-star rating across ${rev} reviews, you're clearly one of the most trusted ${cat}s${loc} — which is exactly why I reached out.`;
  if (r)
    return `As a ${r}-star ${cat}${loc}, you've clearly earned your reputation — I had one idea to turn more of that into booked work.`;
  if (rev && rev >= 10)
    return `${rev}+ reviews${loc} tells me you do great work as a ${cat} — I had a quick idea to help even more people find you.`;
  return `I came across your ${cat} listing${loc} and had a quick idea to help you book more of the customers already searching for you.`;
}

module.exports = { openerFor };
