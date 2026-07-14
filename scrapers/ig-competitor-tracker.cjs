#!/usr/bin/env node
'use strict';

/**
 * scrapers/ig-competitor-tracker.cjs — track a watchlist of competitors,
 * detect new posts, surface engagement deltas.
 *
 * Covers Apify actors:
 *   - instagram-profile-scraper (multi-target with diffing)
 *   - instagram-post-scraper (post-level changes)
 *
 * Usage:
 *   node scrapers/ig-competitor-tracker.cjs --watchlist competitors.txt
 *   node scrapers/ig-competitor-tracker.cjs --watchlist competitors.txt --fresh-window-min 60
 *
 * watchlist file: one IG handle per line (no @ prefix, # for comments).
 *
 * Output:
 *   data/ig-competitors/snapshot-<ts>.json
 *   data/ig-competitors/state.json (persistent — diffs against this)
 *   data/ig-competitors/new-posts-<ts>.json (only on changes)
 */

const fs = require('fs');
const path = require('path');
const { withBrowser, saveJSON, loadEnv, log, DATA_DIR } = require('../lib/browser.cjs');
const { scrapeProfile, scrapeRecent } = require('./ig-scraper.cjs');
loadEnv();

const OUT_DIR = path.join(DATA_DIR, 'ig-competitors');
const STATE = path.join(OUT_DIR, 'state.json');

const arg = (n, d) => { const i = process.argv.indexOf(n); return i === -1 ? d : process.argv[i + 1]; };
const flag = (n) => process.argv.includes(n);

const WATCHLIST = arg('--watchlist');
const POSTS_PER = parseInt(arg('--posts-per', '5'), 10);
const FRESH_WINDOW_MIN = parseInt(arg('--fresh-window-min', '120'), 10);
const DRY = flag('--dry-run');

function loadState() {
  if (!fs.existsSync(STATE)) return { handles: {}, last_run: 0 };
  try { return JSON.parse(fs.readFileSync(STATE, 'utf8')); }
  catch (_) { return { handles: {}, last_run: 0 }; }
}

function saveState(state) { saveJSON(STATE, state); }

async function main() {
  if (!WATCHLIST) {
    log.error('usage: --watchlist <file>');
    process.exit(2);
  }
  const handles = fs.readFileSync(WATCHLIST, 'utf8')
    .split(/\r?\n/).map(s => s.trim())
    .filter(s => s && !s.startsWith('#'))
    .map(s => s.replace(/^@/, ''));

  log.info(`watchlist: ${handles.length} handles`);
  if (DRY) { log.info('dry-run — exiting'); return; }

  const state = loadState();
  const now = Date.now();
  const freshCutoff = (now - FRESH_WINDOW_MIN * 60_000) / 1000; // unix seconds
  const snapshot = { ts: now, handles: {} };
  const newPosts = [];
  const engagementDeltas = [];

  await withBrowser(async (browser) => {
    for (const h of handles) {
      try {
        const profile = await scrapeProfile(browser, h);
        const recent = await scrapeRecent(browser, h, POSTS_PER);
        snapshot.handles[h] = { profile, recent };

        const prior = state.handles[h] || { posts: {}, profile: null };

        // Profile follower delta
        const beforeFollowers = prior.profile?.full_profile?.followers ?? prior.profile?.counts?.followers ?? null;
        const afterFollowers = profile.full_profile?.followers ?? null;
        if (beforeFollowers != null && afterFollowers != null && afterFollowers !== beforeFollowers) {
          engagementDeltas.push({
            handle: h,
            type: 'follower_change',
            before: beforeFollowers,
            after: afterFollowers,
            delta: afterFollowers - beforeFollowers,
          });
        }

        // Post diff
        for (const post of recent.posts || []) {
          const seen = prior.posts[post.shortcode];
          if (!seen) {
            // Brand new post we haven't seen
            const isFresh = post.taken_at_timestamp >= freshCutoff;
            newPosts.push({
              handle: h,
              shortcode: post.shortcode,
              url: post.url,
              caption: (post.caption || '').slice(0, 280),
              likes: post.likes,
              comments: post.comments,
              taken_at: post.taken_at_timestamp,
              fresh: isFresh,
              age_min: Math.round((now / 1000 - post.taken_at_timestamp) / 60),
            });
          } else {
            // Existing post — track engagement movement
            if ((post.likes ?? 0) > (seen.likes ?? 0) * 1.2 && (seen.likes ?? 0) > 50) {
              engagementDeltas.push({
                handle: h,
                shortcode: post.shortcode,
                type: 'likes_surge',
                before: seen.likes,
                after: post.likes,
                pct: Math.round(((post.likes - seen.likes) / seen.likes) * 100),
              });
            }
          }
        }

        // Update state: keep last 20 posts per handle
        const postsMap = {};
        for (const post of (recent.posts || []).slice(0, 20)) {
          postsMap[post.shortcode] = {
            likes: post.likes,
            comments: post.comments,
            caption: post.caption?.slice(0, 280),
            taken_at: post.taken_at_timestamp,
          };
        }
        state.handles[h] = { profile, posts: postsMap, last_scraped: now };

        log.info(`  ${h}: ${recent.posts?.length || 0} recent posts, followers=${afterFollowers ?? '?'}`);
      } catch (e) {
        log.warn(`  ${h} FAIL: ${e.message}`);
      }
    }
  });

  state.last_run = now;
  saveState(state);

  const snapshotFile = path.join(OUT_DIR, `snapshot-${now}.json`);
  saveJSON(snapshotFile, snapshot);
  log.info(`snapshot → ${snapshotFile}`);

  if (newPosts.length || engagementDeltas.length) {
    const reportFile = path.join(OUT_DIR, `new-posts-${now}.json`);
    saveJSON(reportFile, { new_posts: newPosts, engagement_deltas: engagementDeltas, fresh_window_min: FRESH_WINDOW_MIN });
    log.info(`CHANGES: ${newPosts.length} new posts (${newPosts.filter(p => p.fresh).length} fresh), ${engagementDeltas.length} deltas → ${reportFile}`);
  } else {
    log.info('no changes vs last snapshot');
  }
}

if (require.main === module) {
  main().catch(e => { log.error(`fatal: ${e.message}`); process.exit(1); });
}

module.exports = { main };
