#!/usr/bin/env node
'use strict';

/**
 * examples/monitor-competitors.cjs — schedule this to run hourly.
 *
 * Watches the IG handles in examples/competitors.txt, detects new posts,
 * surfaces engagement deltas, writes a report.
 *
 * Run: node examples/monitor-competitors.cjs
 *
 * Cron-friendly: exits cleanly. To schedule:
 *   - Linux/Mac cron: 0 * * * * cd /path/to/package && node examples/monitor-competitors.cjs
 *   - Windows Task Scheduler: action = node, args = examples\monitor-competitors.cjs
 */

const { spawn } = require('child_process');
const path = require('path');

const watchlist = path.join(__dirname, 'competitors.txt');
const tracker = path.join(__dirname, '..', 'scrapers', 'ig-competitor-tracker.cjs');

const child = spawn(process.execPath, [tracker, '--watchlist', watchlist, '--fresh-window-min', '60'], { stdio: 'inherit' });
child.on('exit', (code) => process.exit(code || 0));
