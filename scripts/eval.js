#!/usr/bin/env node
'use strict';

/**
 * Accuracy report for the deterministic classifier on the bundled labeled samples.
 *   npm run eval              tuning set + hold-out set
 *   npm run eval -- --verbose also print every miss
 *
 * IMPORTANT: the samples are small, synthetic, English-only, and hand-written by the repo author.
 * Treat the numbers as a regression guard, NOT as production accuracy. Always sample your own replies.
 */

const fs = require('fs');
const path = require('path');
const { classify } = require('../src/classifier');
const { decide } = require('../src/router');
const { loadConfig } = require('../src/config');

const ROOT = path.resolve(__dirname, '..');
const cfg = loadConfig({});
const REF = Date.parse('2026-11-10T12:00:00Z');
const ROUTES = ['UNSUBSCRIBE', 'INTERESTED', 'OUT_OF_OFFICE', 'WRONG_PERSON', 'NOT_NOW', 'NOT_INTERESTED', 'REVIEW'];

function run(file) {
  const rows = JSON.parse(fs.readFileSync(path.join(ROOT, file), 'utf8')).replies;
  const results = rows.map((r) => {
    const c = classify({ from: { email: 'person@example.com' }, subject: r.subject, body: r.body, headers: r.headers }, { refMs: REF });
    const d = decide(c, cfg);
    return { ...r, route: d.route, confidence: c.confidence, label: c.label };
  });
  return results;
}

function report(name, results, verbose) {
  const ok = results.filter((r) => r.route === r.expected).length;
  console.log(`\n${name}: ${ok}/${results.length} routed as expected (${Math.round((ok / results.length) * 100)}%)`);
  console.log('  ' + 'class'.padEnd(16) + 'n'.padEnd(5) + 'recall'.padEnd(9) + 'precision');
  for (const cls of ROUTES) {
    const actual = results.filter((r) => r.expected === cls);
    const predicted = results.filter((r) => r.route === cls);
    const hit = actual.filter((r) => r.route === cls).length;
    const recall = actual.length ? `${Math.round((hit / actual.length) * 100)}%` : '-';
    const precision = predicted.length ? `${Math.round((predicted.filter((r) => r.expected === cls).length / predicted.length) * 100)}%` : '-';
    console.log('  ' + cls.padEnd(16) + String(actual.length).padEnd(5) + recall.padEnd(9) + precision);
  }
  const misses = results.filter((r) => r.route !== r.expected);
  if (misses.length && verbose) {
    console.log('  misses:');
    misses.forEach((r) => console.log(`   - [${r.id}] expected ${r.expected}, got ${r.route} (${r.label} ${r.confidence}): ${JSON.stringify(r.body).slice(0, 90)}`));
  }
  return { ok, total: results.length, misses };
}

if (require.main === module) {
  const verbose = process.argv.includes('--verbose');
  report('Tuning set   (sample-data/labeled-replies.json)', run('sample-data/labeled-replies.json'), verbose);
  if (fs.existsSync(path.join(ROOT, 'sample-data/holdout-replies.json'))) {
    report('Hold-out set (sample-data/holdout-replies.json)', run('sample-data/holdout-replies.json'), verbose);
  }
  console.log('\nNote: small synthetic English samples - a regression guard, not a production accuracy claim.\n');
}

module.exports = { run, report };
