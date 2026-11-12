'use strict';

/**
 * Minimal n8n Code-node harness: runs the REAL generated jsCode from workflows/*.json with HTTP calls
 * mocked. No n8n, no network, no accounts required.
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const loadJson = (rel) => JSON.parse(fs.readFileSync(path.join(ROOT, rel), 'utf8'));
const loadWorkflow = (file) => loadJson(path.join('workflows', file));
const loadPayload = (file) => loadJson(path.join('docs/sample-payloads', file));

const wrap = (arr) => ({ first: () => arr[0], last: () => arr[arr.length - 1], all: () => arr, item: arr[0] });

function runCodeNode(wf, nodeName, { input, nodes, env, staticData }) {
  const n = wf.nodes.find((x) => x.name === nodeName);
  if (!n) throw new Error(`No node named "${nodeName}"`);
  const $ = (name) => {
    if (!nodes[name]) throw new Error(`Node "${name}" has no output in this simulation`);
    return wrap(nodes[name]);
  };
  const fn = new Function('$input', '$', '$env', '$getWorkflowStaticData', n.parameters.jsCode);
  return fn(wrap(input), $, env || {}, () => staticData);
}

function withFixedNow(iso, fn) {
  const real = Date.now;
  Date.now = () => Date.parse(iso);
  try {
    return fn();
  } finally {
    Date.now = real;
  }
}

/** Fake-but-realistic live settings. example.invalid URLs can never resolve. */
const LIVE_ENV = {
  SANDBOX_MODE: 'false',
  SLACK_WEBHOOK_URL: 'https://example.invalid/slack',
  SUPPRESSION_WEBHOOK_URL: 'https://example.invalid/suppress',
  SEQUENCE_WEBHOOK_URL: 'https://example.invalid/sequence',
  HUBSPOT_ENABLED: 'true',
  SEQUENCE_PROVIDER: 'apollo',
  OWNER_SLACK_MAP_JSON: '{"900001":"U0EXAMPLE01"}',
};

const HUBSPOT_FOUND = { results: [{ id: '100001', properties: { hubspot_owner_id: '900001' } }] };

/**
 * Simulate "Outbound Reply Triage Router" for one webhook call.
 * @param {object} o  { payload, headers, env, staticData, nowIso, hubspotSearch, llmResponse }
 */
function simulateReply(o) {
  const wf = loadWorkflow('01-reply-triage-router.json');
  const env = o.env || {};
  const staticData = o.staticData || {};
  return withFixedNow(o.nowIso || '2026-11-10T14:05:00.000Z', () => {
    const nodes = {};
    const run = (name, input) => (nodes[name] = runCodeNode(wf, name, { input, nodes, env, staticData }));
    const result = { nodes, duplicate: false, llmCalled: false };

    run('Load Config & Normalize', [{ json: { body: o.payload, headers: o.headers || {} } }]);
    if (nodes['Load Config & Normalize'][0].json.duplicate) return Object.assign(result, { duplicate: true });

    const classified = run('Classify (Rules)', nodes['Load Config & Normalize']);
    let decideInput = classified;
    if (classified[0].json.needsLlm) {
      result.llmCalled = true;
      result.llmRequest = classified[0].json.llmRequest;
      const resp = o.llmResponse === undefined ? { error: { message: 'no mock' } } : o.llmResponse;
      decideInput = run('Merge LLM Result', [{ json: resp }]);
    }
    const decided = run('Decide Route', decideInput);

    let attachInput = decided;
    if (decided[0].json.hubspotLookup) {
      nodes['HubSpot: Find Contact'] = [{ json: o.hubspotSearch === undefined ? HUBSPOT_FOUND : o.hubspotSearch }];
      attachInput = nodes['HubSpot: Find Contact'];
    }
    run('Attach Contact', attachInput);
    run('Plan Actions', nodes['Attach Contact']);
    run('Split Actions', nodes['Plan Actions']);
    result.response = nodes['Plan Actions'][0].json.response;
    result.plan = nodes['Plan Actions'][0].json.plan;
    result.items = nodes['Split Actions'];
    result.kinds = result.items.map((i) => i.json.action.kind);
    return result;
  });
}

function simulateResume({ env, staticData, nowIso }) {
  const wf = loadWorkflow('01-reply-triage-router.json');
  return withFixedNow(nowIso, () => runCodeNode(wf, 'Collect Due Resumes', { input: [{ json: {} }], nodes: {}, env, staticData }));
}

module.exports = { ROOT, loadJson, loadWorkflow, loadPayload, runCodeNode, withFixedNow, simulateReply, simulateResume, LIVE_ENV, HUBSPOT_FOUND };
