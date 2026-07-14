#!/usr/bin/env node
'use strict';

/**
 * examples/hashtag-research.cjs — pull top + recent posts for a list of
 * hashtags, save a research bundle.
 *
 * Run: node examples/hashtag-research.cjs aitools marketing automation
 */

const path = require('path');
const fs = require('fs');
const { withBrowser, saveJSON, log, DATA_DIR } = require('../lib/browser.cjs');
const { scrapeHashtag } = require('../scrapers/ig-scraper.cjs');

const tags = process.argv.slice(2);
if (!tags.length) {
  console.error('usage: node examples/hashtag-research.cjs tag1 tag2 ...');
  process.exit(2);
}

(async () => {
  await withBrowser(async (browser) => {
    const out = { tags: {}, scraped_at: Date.now() };
    for (const tag of tags) {
      try {
        out.tags[tag] = await scrapeHashtag(browser, tag, 30);
        log.info(`  #${tag}: ${out.tags[tag].top_posts.length} top + ${out.tags[tag].recent_posts.length} recent`);
      } catch (e) {
        out.tags[tag] = { error: e.message };
        log.warn(`  #${tag} FAIL: ${e.message}`);
      }
    }
    const file = path.join(DATA_DIR, 'hashtag-research', `bundle-${Date.now()}.json`);
    saveJSON(file, out);
    log.info(`bundle → ${file}`);
  });
})().catch(e => { console.error(e); process.exit(1); });
