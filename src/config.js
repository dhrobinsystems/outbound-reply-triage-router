'use strict';

/**
 * Central configuration loader (environment variables -> one validated object).
 *
 * SANDBOX_MODE defaults to TRUE and is fail-safe: only an explicit false/0/no/off disables it, so a typo
 * keeps the dry-run gate closed. Secrets (webhook URLs, API tokens) are NEVER copied into this object -
 * only booleans like `slackConfigured` - so they do not end up in n8n execution data.
 */

const ENV_KEYS = [
  'SANDBOX_MODE',
  'CONFIDENCE_THRESHOLD',
  'UNSUBSCRIBE_CONFIDENCE_THRESHOLD',
  'ENABLE_LLM_FALLBACK',
  'LLM_MAX_CONFIDENCE',
  'LLM_MODEL',
  'DATE_FORMAT_PREFERENCE',
  'OOO_DEFAULT_PAUSE_DAYS',
  'OOO_REENROLL_DELAY_DAYS',
  'NOT_NOW_FOLLOWUP_DAYS',
  'INTERESTED_TASK_DUE_HOURS',
  'SEQUENCE_PROVIDER',
  'APOLLO_STOP_MODE',
  'HUBSPOT_ENABLED',
  'OWN_EMAIL_DOMAINS',
  'OWNER_SLACK_MAP_JSON',
  'NOTIFY_ON_UNSUBSCRIBE',
  'NOTIFY_ON_NOT_NOW',
  'PAUSE_ON_REVIEW',
  'REVIEW_CREATE_TASK',
  'SLACK_INCLUDE_EXCERPT',
  'ENABLE_LOCAL_RESUME_QUEUE',
  'MAX_BODY_CHARS',
  // presence-only (the URL itself is read by the HTTP node, never stored in cfg):
  'SLACK_WEBHOOK_URL',
  'SUPPRESSION_WEBHOOK_URL',
  'SEQUENCE_WEBHOOK_URL',
  'LLM_API_URL',
];

/** Copy known keys from an env-like object. If n8n blocks env access, reads throw: stop and use safe defaults. */
function readEnv(source) {
  const env = {};
  for (const key of ENV_KEYS) {
    try {
      const v = source[key];
      if (v !== undefined && v !== null && v !== '') env[key] = v;
    } catch (e) {
      break;
    }
  }
  return env;
}

const present = (v) => v !== undefined && v !== null && String(v).trim() !== '';

function toBool(value, fallback) {
  if (!present(value)) return fallback;
  return ['true', '1', 'yes', 'on'].includes(String(value).trim().toLowerCase());
}

/** Fail-safe: ON unless the value is an explicit off word. */
function toSandbox(value) {
  if (!present(value)) return true;
  return !['false', '0', 'no', 'off'].includes(String(value).trim().toLowerCase());
}

function toNum(value, fallback, name) {
  if (!present(value)) return fallback;
  const n = Number(value);
  if (!Number.isFinite(n)) throw new Error(`${name} must be a number, got "${value}"`);
  return n;
}

function toList(value) {
  return present(value) ? String(value).split(',').map((s) => s.trim().toLowerCase().replace(/^@/, '')).filter(Boolean) : [];
}

function toEnum(value, allowed, fallback, name) {
  if (!present(value)) return fallback;
  const v = String(value).trim().toLowerCase();
  if (!allowed.includes(v)) throw new Error(`${name} must be one of: ${allowed.join(', ')} (got "${value}")`);
  return v;
}

function parseJsonMap(value, name) {
  if (!present(value)) return {};
  try {
    const parsed = typeof value === 'string' ? JSON.parse(value) : value;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('must be a JSON object');
    return parsed;
  } catch (e) {
    throw new Error(`${name} is not a valid JSON object: ${e.message}`);
  }
}

function loadConfig(env) {
  const e = env || {};
  const cfg = {
    sandbox: toSandbox(e.SANDBOX_MODE),
    confidenceThreshold: toNum(e.CONFIDENCE_THRESHOLD, 0.8, 'CONFIDENCE_THRESHOLD'),
    unsubscribeThreshold: toNum(e.UNSUBSCRIBE_CONFIDENCE_THRESHOLD, 0.6, 'UNSUBSCRIBE_CONFIDENCE_THRESHOLD'),
    enableLlmFallback: toBool(e.ENABLE_LLM_FALLBACK, false),
    llmMaxConfidence: toNum(e.LLM_MAX_CONFIDENCE, 0.9, 'LLM_MAX_CONFIDENCE'),
    llmModel: present(e.LLM_MODEL) ? String(e.LLM_MODEL) : 'your-model-name',
    dateFormat: toEnum(e.DATE_FORMAT_PREFERENCE, ['mdy', 'dmy'], 'mdy', 'DATE_FORMAT_PREFERENCE').toUpperCase(),
    oooDefaultPauseDays: toNum(e.OOO_DEFAULT_PAUSE_DAYS, 7, 'OOO_DEFAULT_PAUSE_DAYS'),
    oooReenrollDelayDays: toNum(e.OOO_REENROLL_DELAY_DAYS, 1, 'OOO_REENROLL_DELAY_DAYS'),
    notNowFollowupDays: toNum(e.NOT_NOW_FOLLOWUP_DAYS, 90, 'NOT_NOW_FOLLOWUP_DAYS'),
    interestedTaskDueHours: toNum(e.INTERESTED_TASK_DUE_HOURS, 4, 'INTERESTED_TASK_DUE_HOURS'),
    sequenceProvider: toEnum(e.SEQUENCE_PROVIDER, ['none', 'apollo', 'webhook'], 'none', 'SEQUENCE_PROVIDER'),
    apolloStopMode: toEnum(e.APOLLO_STOP_MODE, ['stop', 'remove'], 'stop', 'APOLLO_STOP_MODE'),
    hubspotEnabled: toBool(e.HUBSPOT_ENABLED, false),
    ownDomains: toList(e.OWN_EMAIL_DOMAINS),
    ownerSlackMap: parseJsonMap(e.OWNER_SLACK_MAP_JSON, 'OWNER_SLACK_MAP_JSON'),
    notifyOnUnsubscribe: toBool(e.NOTIFY_ON_UNSUBSCRIBE, false),
    notifyOnNotNow: toBool(e.NOTIFY_ON_NOT_NOW, false),
    pauseOnReview: toBool(e.PAUSE_ON_REVIEW, true),
    reviewCreateTask: toBool(e.REVIEW_CREATE_TASK, true),
    slackIncludeExcerpt: toBool(e.SLACK_INCLUDE_EXCERPT, true),
    enableLocalResumeQueue: toBool(e.ENABLE_LOCAL_RESUME_QUEUE, true),
    maxBodyChars: toNum(e.MAX_BODY_CHARS, 20000, 'MAX_BODY_CHARS'),
    slackConfigured: present(e.SLACK_WEBHOOK_URL),
    suppressionWebhookConfigured: present(e.SUPPRESSION_WEBHOOK_URL),
    sequenceWebhookConfigured: present(e.SEQUENCE_WEBHOOK_URL),
    llmConfigured: present(e.LLM_API_URL),
  };

  for (const [name, v] of [['CONFIDENCE_THRESHOLD', cfg.confidenceThreshold], ['UNSUBSCRIBE_CONFIDENCE_THRESHOLD', cfg.unsubscribeThreshold], ['LLM_MAX_CONFIDENCE', cfg.llmMaxConfidence]]) {
    if (!(v > 0 && v <= 1)) throw new Error(`${name} must be between 0 (exclusive) and 1`);
  }
  for (const [name, v] of [['OOO_DEFAULT_PAUSE_DAYS', cfg.oooDefaultPauseDays], ['NOT_NOW_FOLLOWUP_DAYS', cfg.notNowFollowupDays], ['MAX_BODY_CHARS', cfg.maxBodyChars]]) {
    if (!(v > 0)) throw new Error(`${name} must be greater than 0`);
  }
  if (cfg.enableLlmFallback && !cfg.llmConfigured) {
    throw new Error('ENABLE_LLM_FALLBACK=true requires LLM_API_URL (an OpenAI-compatible chat-completions endpoint)');
  }
  return cfg;
}

// @build:strip-start
module.exports = { ENV_KEYS, readEnv, loadConfig };
// @build:strip-end
