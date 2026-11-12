// Code node: "Load Config & Normalize" (Run Once for All Items)
// Loads settings, validates + normalizes the incoming webhook body, and de-duplicates replies by replyId.
// If your n8n blocks $env access, hard-code settings here instead, e.g. { SANDBOX_MODE: 'true' }.
const OVERRIDES = {};

const env = Object.assign(readEnv($env), OVERRIDES);
const cfg = loadConfig(env);
const req = $input.first().json;
const nowMs = Date.now();
const reply = normalizePayload(req.body, req.headers, { maxBodyChars: cfg.maxBodyChars, nowMs });

// Idempotency: providers retry webhooks. Sandbox runs never record anything.
const state = $getWorkflowStaticData('global');
state.processed = state.processed || {};
Object.keys(state.processed).forEach((k) => { if (state.processed[k] < nowMs - 14 * 86400000) delete state.processed[k]; });
const duplicate = Boolean(state.processed[reply.replyId]);
if (!duplicate && !cfg.sandbox) state.processed[reply.replyId] = nowMs;

return [{ json: { cfg, reply, duplicate, sandbox: cfg.sandbox } }];
