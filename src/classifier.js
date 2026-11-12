'use strict';

/**
 * Deterministic reply classifier (no LLM, no network).
 *
 * Output label is one of: UNSUBSCRIBE, INTERESTED, OUT_OF_OFFICE, WRONG_PERSON, NOT_NOW, NOT_INTERESTED,
 * BOUNCE (system sender), or UNKNOWN (nothing matched).
 *
 * Confidence = top label score, reduced when a competing label also scores well, so mixed-signal replies
 * ("sounds interesting, but not right now") drop below CONFIDENCE_THRESHOLD and go to human review.
 */

// @build:strip-start
const { LABELS, RULES, NEGATION_RE } = require('./rules');
const { cleanReply, stripHtml } = require('./text');
const { parseReturnDate, parseSnoozeDays, extractReferral } = require('./extractors');
// @build:strip-end

const STRONG_UNSUBSCRIBE = 0.9;
const MARGIN_FLOOR = 0.3; // competing scores below this do not reduce confidence
const MARGIN_PENALTY = 0.5;
const LONG_REPLY_CHARS = 1500;
// "Interested, but not now" is still NOT_NOW: interest alongside a deferral barely lowers confidence.
// "until <date>" also looks like a deferral, but an explicit away message wins.
const PAIR_PENALTY = { 'NOT_NOW|INTERESTED': 0.2, 'OUT_OF_OFFICE|NOT_NOW': 0.1 };

const round3 = (n) => Math.round(n * 1000) / 1000;
const noisyOr = (weights) => 1 - weights.reduce((p, w) => p * (1 - w), 1);

function headerValue(headers, name) {
  if (!headers) return '';
  const key = Object.keys(headers).find((k) => k.toLowerCase() === name);
  return key ? String(headers[key]) : '';
}

function hasAutoReplyHeaders(headers) {
  const autoSubmitted = headerValue(headers, 'auto-submitted').toLowerCase();
  const precedence = headerValue(headers, 'precedence').toLowerCase();
  return (
    (autoSubmitted && autoSubmitted !== 'no') ||
    Boolean(headerValue(headers, 'x-autoreply')) ||
    Boolean(headerValue(headers, 'x-autorespond')) ||
    precedence === 'auto_reply'
  );
}

/** Label-specific detail extraction (return date, snooze length, referred contact). */
function extractFor(label, text, cleaned, senderEmail, o) {
  const extracted = {};
  if (label === 'OUT_OF_OFFICE') {
    const rd = parseReturnDate(text, o.refMs, o.dateFormat);
    if (rd) extracted.returnDate = rd;
  }
  if (label === 'NOT_NOW') {
    const days = parseSnoozeDays(text, o.refMs);
    if (days) extracted.snoozeDays = days;
  }
  if (label === 'WRONG_PERSON') {
    const referral = extractReferral(cleaned, senderEmail, o.ownDomains);
    if (referral) extracted.referral = referral;
  }
  return extracted;
}

/**
 * @param {object} reply  { from:{email}, subject, body, html, headers, receivedAt }
 * @param {object} opts   { dateFormat, ownDomains, refMs }
 */
function classify(reply, opts) {
  const o = Object.assign({ dateFormat: 'MDY', ownDomains: [], refMs: Date.now() }, opts);
  const subject = String(reply.subject || '');
  const bodySource = reply.body && String(reply.body).trim() ? reply.body : stripHtml(reply.html);
  const cleaned = cleanReply(bodySource);
  const text = `${subject}\n${cleaned}`.trim();
  const senderEmail = (reply.from && reply.from.email) || '';

  const base = { cleanedText: cleaned, scores: {}, matches: [], extracted: {}, signals: { autoReplyHeader: false }, source: 'rules' };

  // System senders (bounces) are not replies from a person.
  if (/^(?:mailer-daemon|postmaster)@/i.test(senderEmail) || /\b(?:undeliverable|delivery status notification|mail delivery (?:failed|subsystem))\b/i.test(subject)) {
    return Object.assign(base, { label: 'BOUNCE', confidence: 0.95 });
  }

  const positiveText = text.replace(NEGATION_RE, ' ');
  const matches = [];
  for (const rule of RULES) {
    if (rule.re.test(rule.on === 'positive' ? positiveText : text)) matches.push({ id: rule.id, label: rule.label, weight: rule.weight });
  }
  if (hasAutoReplyHeaders(reply.headers)) {
    base.signals.autoReplyHeader = true;
    matches.push({ id: 'hdr-auto-reply', label: 'OUT_OF_OFFICE', weight: 0.9 });
  }

  const scores = {};
  for (const label of LABELS) {
    const ws = matches.filter((m) => m.label === label).map((m) => m.weight);
    scores[label] = ws.length ? round3(noisyOr(ws)) : 0;
  }
  base.scores = scores;
  base.matches = matches;

  let label = 'UNKNOWN';
  let confidence = 0;

  const strongUnsub = matches.some((m) => m.label === 'UNSUBSCRIBE' && m.weight >= STRONG_UNSUBSCRIBE);
  if (strongUnsub) {
    // Compliance-first: an explicit opt-out beats every other signal in the message.
    label = 'UNSUBSCRIBE';
    confidence = scores.UNSUBSCRIBE;
  } else {
    const ranked = LABELS.map((l) => ({ l, s: scores[l] })).sort((a, b) => b.s - a.s);
    const top = ranked[0];
    const second = ranked[1];
    if (top.s > 0) {
      label = top.l;
      confidence = top.s * (1 - (PAIR_PENALTY[`${top.l}|${second.l}`] || MARGIN_PENALTY) * Math.max(0, second.s - MARGIN_FLOOR));
      if (cleaned.length > LONG_REPLY_CHARS) confidence *= 0.9;
    }
  }
  confidence = round3(confidence);

  const extracted = extractFor(label, text, cleaned, senderEmail, o);

  return Object.assign(base, { label, confidence, extracted });
}

// @build:strip-start
module.exports = { classify, extractFor, hasAutoReplyHeaders, STRONG_UNSUBSCRIBE };
// @build:strip-end
