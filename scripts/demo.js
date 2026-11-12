#!/usr/bin/env node
'use strict';

/**
 * Offline demo (no n8n, no accounts, no network): runs every sample payload through the REAL generated
 * workflow Code-node logic in SANDBOX mode and prints the routing decision and the actions that WOULD run.
 *
 *   npm run demo
 *   npm run demo -- --live-plan    show the plan with Apollo + HubSpot + Slack configured (still nothing is sent)
 */

const fs = require('fs');
const path = require('path');
const H = require('../tests/harness');

const livePlan = process.argv.includes('--live-plan');
const env = livePlan ? { ...H.LIVE_ENV, SANDBOX_MODE: 'true' } : {};
const dir = path.join(H.ROOT, 'docs/sample-payloads');
const pad = (s, n) => String(s).padEnd(n);

console.log(`\nReply Triage Router demo | SANDBOX_MODE=true | ${livePlan ? 'plan with Apollo + HubSpot + Slack configured' : 'default config (no providers configured)'}\n`);
console.log(pad('payload', 34) + pad('route', 16) + pad('conf', 7) + 'planned actions (not executed)');
for (const file of fs.readdirSync(dir).filter((f) => f.endsWith('.json')).sort()) {
  const r = H.simulateReply({ payload: H.loadPayload(file), env, staticData: {} });
  const resp = r.response;
  console.log(pad(file.replace('.json', ''), 34) + pad(resp.route, 16) + pad(resp.confidence, 7) + (r.kinds.join(', ') || '-'));
}
console.log('\nNothing was sent, written, or paused. See docs/SETUP.md to test against your own n8n.\n');
