'use strict';

/**
 * Slack Block Kit builders (incoming-webhook payloads). Contact emails are masked and reply excerpts are
 * short; set SLACK_INCLUDE_EXCERPT=false to omit excerpts entirely.
 * Preview any payload in https://app.slack.com/block-kit-builder
 */

// @build:strip-start
const { maskEmail, maskEmailsInText, truncate } = require('./text');
// @build:strip-end

const esc = (s) => String(s === undefined || s === null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

const KINDS = {
  INTERESTED: { icon: '🔥', title: 'Interested reply - follow up now' },
  REVIEW: { icon: '🧐', title: 'Reply needs human review' },
  WRONG_PERSON: { icon: '🔀', title: 'Wrong person - referral found' },
  UNSUBSCRIBE_NO_TARGET: { icon: '🛑', title: 'Opt-out received - ACTION REQUIRED' },
  UNSUBSCRIBE_FYI: { icon: '✅', title: 'Opt-out processed' },
  NOT_NOW_FYI: { icon: '🕐', title: 'Not now - follow-up scheduled' },
  RESUME_REMINDER: { icon: '⏰', title: 'Out-of-office contact is back - re-enroll' },
};

const section = (text) => ({ type: 'section', text: { type: 'mrkdwn', text } });
const context = (text) => ({ type: 'context', elements: [{ type: 'mrkdwn', text }] });

function ownerMention(cfg, ownerId) {
  const id = ownerId ? (cfg.ownerSlackMap || {})[String(ownerId)] : '';
  return id && /^[UW][A-Z0-9]{6,}$/.test(id) ? `<@${id}>` : '';
}

/**
 * @param {string} kind  key of KINDS
 * @param {object} ctx   { reply, classification, decision, cfg, ownerId, hubspotFound, extra }
 */
function buildSlackPayload(kind, ctx) {
  const meta = KINDS[kind] || { icon: 'ℹ️', title: kind };
  const { reply, classification: c, decision, cfg } = ctx;
  const prefix = cfg.sandbox ? '[SANDBOX] ' : '';
  const pct = `${Math.round((c.confidence || 0) * 100)}%`;
  const owner = ownerMention(cfg, ctx.ownerId);

  const blocks = [
    { type: 'header', text: { type: 'plain_text', text: `${prefix}${meta.icon} ${meta.title}`, emoji: true } },
    section(
      `*${esc(maskEmail(reply.contact.email || reply.from.email))}*${reply.from.name ? ` (${esc(reply.from.name)})` : ''}\n` +
        `Subject: ${esc(truncate(reply.subject, 120)) || '_(none)_'}`
    ),
    {
      type: 'section',
      fields: [
        { type: 'mrkdwn', text: `*Classified as*\n${esc(c.label)} · ${pct}${c.source === 'llm' ? ' (LLM)' : ''}` },
        { type: 'mrkdwn', text: `*Source*\n${esc(reply.source)}${reply.sequence.name ? ` · ${esc(reply.sequence.name)}` : ''}` },
      ].concat(owner ? [{ type: 'mrkdwn', text: `*Owner*\n${owner}` }] : []),
    },
  ];

  if (kind === 'REVIEW') {
    const why = decision && decision.reason ? decision.reason : 'below confidence threshold';
    blocks.push(section(`*Why review:* ${esc(why)}\n*Top rule hits:* ${esc((c.matches || []).slice(0, 4).map((m) => m.id).join(', ')) || 'none'}`));
  }
  if (kind === 'WRONG_PERSON') {
    const r = (c.extracted && c.extracted.referral) || null;
    blocks.push(
      section(
        r
          ? `*Referred contact* (best-effort extraction - verify before use)\nName: ${esc(r.name) || '_unknown_'}${r.nameFromEmail ? ' _(guessed from email)_' : ''}\nTitle: ${esc(r.title) || '_unknown_'}\nEmail: ${esc(maskEmail(r.email)) || '_not found_'}`
          : '_No referred contact could be extracted from the reply._'
      )
    );
  }
  if (kind === 'UNSUBSCRIBE_NO_TARGET') {
    blocks.push(section('No suppression target is configured (HubSpot opt-out or `SUPPRESSION_WEBHOOK_URL`). *Suppress this address manually now.*'));
  }
  if (kind === 'RESUME_REMINDER' && ctx.extra && ctx.extra.note) blocks.push(section(esc(ctx.extra.note)));

  if (cfg.slackIncludeExcerpt && c.cleanedText && kind !== 'RESUME_REMINDER') {
    blocks.push(section(`> ${esc(truncate(maskEmailsInText(c.cleanedText).replace(/\s+/g, ' '), 280))}`));
  }
  if (ctx.hubspotFound === false && cfg.hubspotEnabled) blocks.push(context('⚠️ Contact not found in HubSpot - CRM task could not be created.'));
  blocks.push(context(`Reply Triage Router · reply ${esc(reply.replyId)}${cfg.sandbox ? ' · sandbox preview' : ''}`));

  return { text: `${prefix}${meta.title}`, blocks };
}

/** Error-handler payload. Never includes reply content. */
function buildErrorPayload(info) {
  const prefix = info.sandbox ? '[SANDBOX] ' : '';
  return {
    text: `${prefix}Reply Triage Router error in ${info.workflowName}`,
    blocks: [
      { type: 'header', text: { type: 'plain_text', text: `${prefix}❌ Workflow error`, emoji: true } },
      section(`*Workflow:* ${esc(info.workflowName)}\n*Node:* ${esc(info.nodeName)}\n*Error:* ${esc(truncate(info.message, 400))}`),
      context(`Execution ${esc(info.executionId || 'n/a')} · a reply may need manual handling`),
    ],
  };
}

// @build:strip-start
module.exports = { esc, KINDS, ownerMention, buildSlackPayload, buildErrorPayload };
// @build:strip-end
