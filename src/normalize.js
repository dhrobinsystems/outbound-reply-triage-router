'use strict';

/**
 * Turns an incoming webhook body into one normalized reply object.
 * Accepts a documented generic schema plus tolerant aliases for Apollo- and HubSpot-style payloads.
 * Adapters are best-effort: always confirm field names against what YOUR tool actually sends
 * (use the generic schema in schemas/reply-payload.schema.json if they differ).
 */

// @build:strip-start
const { hashString } = require('./text');
// @build:strip-end

const getPath = (obj, path) => path.split('.').reduce((acc, key) => (acc === undefined || acc === null ? undefined : acc[key]), obj);

function pick(obj, paths) {
  for (const p of paths) {
    const v = getPath(obj, p);
    if (v !== undefined && v !== null && String(v).trim() !== '') return v;
  }
  return '';
}

/** "Jane Doe <jane@example.com>" or "jane@example.com" -> { email, name } */
function parseAddress(value) {
  const s = String(value || '').trim();
  const m = /^(.*?)<([^>]+)>$/.exec(s);
  if (m) return { name: m[1].replace(/^["'\s]+|["'\s]+$/g, ''), email: m[2].trim().toLowerCase() };
  return { name: '', email: s.toLowerCase() };
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const numericId = (v) => (/^\d+$/.test(String(v).trim()) ? String(v).trim() : '');

function normalizePayload(body, headers, opts) {
  const o = Object.assign({ maxBodyChars: 20000, nowMs: Date.now() }, opts);
  const b = body && typeof body === 'object' ? body : {};
  const h = {};
  Object.keys(headers || {}).forEach((k) => { h[k.toLowerCase()] = headers[k]; });

  const source = String(pick(b, ['source']) || h['x-reply-source'] || 'generic').toLowerCase();

  let from = { email: '', name: '' };
  if (b.from && typeof b.from === 'object') from = { email: String(b.from.email || '').trim().toLowerCase(), name: String(b.from.name || '') };
  else if (typeof b.from === 'string') from = parseAddress(b.from);
  else from = { email: String(pick(b, ['fromEmail', 'from_email', 'sender_email', 'sender', 'email', 'contact.email'])).trim().toLowerCase(), name: String(pick(b, ['fromName', 'from_name'])) };
  if (!EMAIL_RE.test(from.email)) throw new Error('Payload needs a valid sender email (from.email / fromEmail / email)');

  const html = String(pick(b, ['html', 'body_html', 'reply_html']));
  const text = String(pick(b, ['body', 'text', 'plain', 'reply_text', 'reply_body', 'message', 'content']));
  if (!text.trim() && !html.trim()) throw new Error('Payload needs a reply body (body / text / reply_text / html)');

  const receivedRaw = pick(b, ['receivedAt', 'received_at', 'timestamp', 'date', 'created_at']);
  const receivedMs = receivedRaw ? Date.parse(receivedRaw) : NaN;
  const receivedAt = new Date(Number.isFinite(receivedMs) ? receivedMs : o.nowMs).toISOString();

  const subject = String(pick(b, ['subject', 'email_subject']));
  const hubspotRaw = pick(b, ['contact.hubspotContactId', 'hubspotContactId', 'hubspot_contact_id', source === 'hubspot' ? 'contactId' : 'hs_contact_id', 'hs_object_id', 'objectId']);

  const reply = {
    source,
    receivedAt,
    from,
    subject,
    body: text.slice(0, o.maxBodyChars),
    html: text.trim() ? '' : html.slice(0, o.maxBodyChars),
    headers: b.headers && typeof b.headers === 'object' ? b.headers : {},
    contact: {
      email: String(pick(b, ['contact.email', 'contactEmail']) || from.email).toLowerCase(),
      hubspotContactId: numericId(hubspotRaw),
      apolloContactId: String(pick(b, ['contact.apolloContactId', 'apolloContactId', 'apollo_contact_id', source === 'apollo' ? 'contact_id' : 'apollo_id'])),
    },
    sequence: {
      id: String(pick(b, ['sequence.id', 'sequenceId', 'sequence_id'])),
      name: String(pick(b, ['sequence.name', 'sequenceName', 'sequence_name'])),
      apolloSequenceId: String(pick(b, ['sequence.apolloSequenceId', 'apolloSequenceId', 'apollo_sequence_id', 'emailer_campaign_id'])),
    },
  };
  reply.replyId = String(pick(b, ['replyId', 'reply_id', 'id', 'message_id', 'messageId']) || `r_${hashString(`${from.email}|${subject}|${receivedAt}|${(text || html).slice(0, 200)}`)}`);
  return reply;
}

// @build:strip-start
module.exports = { normalizePayload, parseAddress };
// @build:strip-end
