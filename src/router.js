'use strict';

/**
 * Routing decision + action planning.
 *
 *   decide()        classification -> route (a label, REVIEW, or BOUNCE)
 *   planActions()   route -> the list of side effects to perform (nothing is executed here)
 *   planResume()    due out-of-office queue items -> resume actions
 *
 * Everything returned is data. The workflow's SANDBOX_MODE gate decides whether any of it is executed.
 */

// @build:strip-start
const { addDaysIso } = require('./extractors');
const { maskEmail, truncate } = require('./text');
const { buildSlackPayload } = require('./slack-blocks');
// @build:strip-end

const MS_PER_HOUR = 3600000;
const MS_PER_DAY = 86400000;

const ROUTES = ['UNSUBSCRIBE', 'INTERESTED', 'OUT_OF_OFFICE', 'WRONG_PERSON', 'NOT_NOW', 'NOT_INTERESTED', 'REVIEW', 'BOUNCE'];

/** Executor outputs of the "Route Action" switch node. */
const ACTION_OUTPUT = {
  HUBSPOT_OPT_OUT: 0,
  SUPPRESSION_WEBHOOK: 1,
  APOLLO_STOP_SEQUENCE: 2,
  SEQUENCE_WEBHOOK: 3,
  HUBSPOT_CREATE_TASK: 4,
  SLACK: 5,
};

function decide(classification, cfg) {
  const { label, confidence } = classification;
  if (label === 'BOUNCE') return { route: 'BOUNCE', reason: 'System sender (bounce / delivery notification)' };
  if (label === 'UNSUBSCRIBE' && confidence >= cfg.unsubscribeThreshold) {
    return { route: 'UNSUBSCRIBE', reason: 'Opt-out honored (threshold is intentionally lower than CONFIDENCE_THRESHOLD)' };
  }
  if (label === 'UNKNOWN') return { route: 'REVIEW', reason: 'No classification rule matched' };
  if (confidence < cfg.confidenceThreshold) {
    return { route: 'REVIEW', reason: `Confidence ${confidence} is below CONFIDENCE_THRESHOLD ${cfg.confidenceThreshold} (best guess: ${label})` };
  }
  return { route: label, reason: `Confidence ${confidence} meets CONFIDENCE_THRESHOLD ${cfg.confidenceThreshold}` };
}

function displayName(reply) {
  return reply.from.name || maskEmail(reply.contact.email || reply.from.email);
}

function planActions(ctx) {
  const { reply, classification: c, decision, cfg, nowMs } = ctx;
  const contact = ctx.contact || {};
  const hubspotId = contact.hubspotContactId || reply.contact.hubspotContactId || '';
  const ownerId = contact.ownerId || '';
  const actions = [];
  const stateOps = [];
  const notes = [];
  const counts = {};

  const add = (kind, request) => {
    counts[kind] = (counts[kind] || 0) + 1;
    actions.push({ id: `${reply.replyId}:${kind}:${counts[kind]}`, kind, route: decision.route, outputIndex: ACTION_OUTPUT[kind], request });
  };

  const slack = (kind, extra) => {
    if (!cfg.slackConfigured && !cfg.sandbox) {
      notes.push(`Slack ${kind} skipped: SLACK_WEBHOOK_URL not set`);
      return;
    }
    add('SLACK', { body: buildSlackPayload(kind, { reply, classification: c, decision, cfg, ownerId, hubspotFound: Boolean(hubspotId), extra }) });
  };

  const task = (subject, body, dueMs, priority) => {
    if (!cfg.hubspotEnabled) return notes.push('CRM task skipped: HUBSPOT_ENABLED=false');
    if (!hubspotId) return notes.push('CRM task skipped: HubSpot contact not found');
    const properties = {
      hs_timestamp: new Date(dueMs).toISOString(),
      hs_task_subject: truncate(subject, 250),
      hs_task_body: truncate(body, 2000),
      hs_task_status: 'NOT_STARTED',
      hs_task_priority: priority,
      hs_task_type: 'TODO',
    };
    if (ownerId) properties.hubspot_owner_id = String(ownerId);
    add('HUBSPOT_CREATE_TASK', {
      body: { properties, associations: [{ to: { id: hubspotId }, types: [{ associationCategory: 'HUBSPOT_DEFINED', associationTypeId: 204 }] }] },
    });
    return true;
  };

  const pause = (reason, resumeAtIso) => {
    const email = reply.contact.email || reply.from.email;
    if (cfg.sequenceProvider === 'apollo') {
      const cid = reply.contact.apolloContactId;
      const sid = reply.sequence.apolloSequenceId;
      if (!cid || !sid) {
        notes.push('Sequence not paused: payload has no apolloContactId / apolloSequenceId');
        return false;
      }
      add('APOLLO_STOP_SEQUENCE', { body: { contact_ids: [cid], emailer_campaign_ids: [sid], mode: cfg.apolloStopMode, stop_reason: reason } });
      return true;
    }
    if (cfg.sequenceProvider === 'webhook' && cfg.sequenceWebhookConfigured) {
      add('SEQUENCE_WEBHOOK', { body: { action: 'pause', contactEmail: email, sequenceId: reply.sequence.id || null, reason, resumeAt: resumeAtIso || null, replyId: reply.replyId, route: decision.route } });
      return true;
    }
    notes.push('Sequence not paused: SEQUENCE_PROVIDER is "none" (or SEQUENCE_WEBHOOK_URL missing)');
    return false;
  };

  const who = displayName(reply);
  const excerpt = truncate(c.cleanedText.replace(/\s+/g, ' '), 500);
  const taskBody = (extra) => `${extra ? `${extra}\n\n` : ''}Reply (${c.label}, confidence ${Math.round(c.confidence * 100)}%):\n"${excerpt}"\n\nSource: ${reply.source} · reply ${reply.replyId}`;

  switch (decision.route) {
    case 'UNSUBSCRIBE': {
      let targets = 0;
      if (cfg.hubspotEnabled && hubspotId) {
        add('HUBSPOT_OPT_OUT', { contactId: hubspotId, body: { properties: { hs_email_optout: 'true' } } });
        targets++;
      } else if (cfg.hubspotEnabled) {
        notes.push('HubSpot opt-out skipped: contact not found');
      }
      if (cfg.suppressionWebhookConfigured) {
        add('SUPPRESSION_WEBHOOK', { body: { email: reply.contact.email || reply.from.email, reason: 'reply_unsubscribe', replyId: reply.replyId, source: reply.source, receivedAt: reply.receivedAt, confidence: c.confidence, matchedRules: c.matches.map((m) => m.id) } });
        targets++;
      }
      pause('Contact requested removal');
      if (!targets) slack('UNSUBSCRIBE_NO_TARGET');
      else if (cfg.notifyOnUnsubscribe) slack('UNSUBSCRIBE_FYI');
      break;
    }
    case 'INTERESTED':
      pause('Positive reply - handing off to a human');
      task(`Interested reply: follow up with ${who}`, taskBody('Respond quickly - this person replied positively to outbound.'), nowMs + cfg.interestedTaskDueHours * MS_PER_HOUR, 'HIGH');
      slack('INTERESTED');
      break;
    case 'OUT_OF_OFFICE': {
      const rd = c.extracted.returnDate;
      const resumeAt = rd ? `${addDaysIso(rd.returnDate, cfg.oooReenrollDelayDays)}T12:00:00.000Z` : new Date(nowMs + cfg.oooDefaultPauseDays * MS_PER_DAY).toISOString();
      if (pause('Out of office', resumeAt) && cfg.enableLocalResumeQueue) {
        stateOps.push({
          op: 'enqueueResume',
          item: {
            key: reply.replyId,
            resumeAt,
            email: reply.contact.email || reply.from.email,
            name: reply.from.name || '',
            hubspotContactId: hubspotId,
            apolloContactId: reply.contact.apolloContactId,
            apolloSequenceId: reply.sequence.apolloSequenceId,
            sequenceId: reply.sequence.id,
            basis: rd ? rd.basis : 'default-pause',
          },
        });
      }
      break;
    }
    case 'WRONG_PERSON': {
      const r = c.extracted.referral;
      pause('Wrong person');
      const details = r ? `Referred contact (extracted automatically - verify): ${r.name || 'name unknown'}${r.title ? `, ${r.title}` : ''}${r.email ? `, ${r.email}` : ''}` : 'No referred contact could be extracted - read the reply.';
      task(`Enrich referred contact${r && r.name ? `: ${r.name}` : ''} (from ${who})`, taskBody(details), nowMs + MS_PER_DAY, 'MEDIUM');
      slack('WRONG_PERSON');
      break;
    }
    case 'NOT_NOW': {
      const days = c.extracted.snoozeDays || cfg.notNowFollowupDays;
      pause('Not now', new Date(nowMs + days * MS_PER_DAY).toISOString());
      task(`Follow up with ${who} (asked to wait ~${days} days)`, taskBody('Lead said the timing is not right. Re-engage with fresh context.'), nowMs + days * MS_PER_DAY, 'MEDIUM');
      if (cfg.notifyOnNotNow) slack('NOT_NOW_FYI');
      break;
    }
    case 'NOT_INTERESTED':
      pause('Not interested');
      notes.push('No CRM changes: a clear "no" only stops the sequence (it is not an opt-out).');
      break;
    case 'REVIEW':
      if (cfg.pauseOnReview) pause('Held for human review');
      if (cfg.reviewCreateTask) task(`Review reply classification: ${who}`, taskBody(`Router could not classify this confidently. ${decision.reason}`), nowMs + 4 * MS_PER_HOUR, 'MEDIUM');
      slack('REVIEW');
      break;
    case 'BOUNCE':
      notes.push('Ignored: bounces belong in your sending tool, not in reply triage.');
      break;
    default:
      notes.push(`No plan for route "${decision.route}"`);
  }
  return { actions, stateOps, notes };
}

/** HubSpot contact search body: find the contact (and its owner) by email. Read-only. */
function buildContactLookupBody(email) {
  return {
    filterGroups: [{ filters: [{ propertyName: 'email', operator: 'EQ', value: String(email).toLowerCase() }] }],
    properties: ['hubspot_owner_id', 'firstname', 'lastname', 'hs_email_optout'],
    limit: 1,
  };
}

/** Turn due out-of-office queue items into resume actions. */
function planResume(item, cfg, nowMs) {
  const actions = [];
  const make = (kind, request) => actions.push({ id: `${item.key}:RESUME:${kind}`, kind, route: 'RESUME', outputIndex: ACTION_OUTPUT[kind], request });
  const label = item.name || maskEmail(item.email);

  if (cfg.sequenceProvider === 'webhook' && cfg.sequenceWebhookConfigured) {
    make('SEQUENCE_WEBHOOK', { body: { action: 'resume', contactEmail: item.email, sequenceId: item.sequenceId || null, reason: 'Out-of-office return date reached', replyId: item.key } });
  } else if (cfg.hubspotEnabled && item.hubspotContactId) {
    make('HUBSPOT_CREATE_TASK', {
      body: {
        properties: { hs_timestamp: new Date(nowMs).toISOString(), hs_task_subject: truncate(`Re-enroll ${label} in sequence (back from out of office)`, 250), hs_task_body: 'Out-of-office return date has passed. Re-enroll this contact in the sequence.', hs_task_status: 'NOT_STARTED', hs_task_priority: 'MEDIUM', hs_task_type: 'TODO' },
        associations: [{ to: { id: item.hubspotContactId }, types: [{ associationCategory: 'HUBSPOT_DEFINED', associationTypeId: 204 }] }],
      },
    });
  } else if (cfg.slackConfigured || cfg.sandbox) {
    const reply = { replyId: item.key, source: 'resume-queue', from: { email: item.email, name: item.name }, contact: { email: item.email }, sequence: { name: '' }, subject: '' };
    make('SLACK', {
      body: buildSlackPayload('RESUME_REMINDER', { reply, classification: { label: 'OUT_OF_OFFICE', confidence: 1, cleanedText: '', matches: [], extracted: {} }, decision: {}, cfg, extra: { note: `${label} was out of office until about ${item.resumeAt.slice(0, 10)}. Re-enroll them in the sequence.` } }),
    });
  }
  return actions;
}

// @build:strip-start
module.exports = { ROUTES, ACTION_OUTPUT, decide, planActions, planResume, buildContactLookupBody };
// @build:strip-end
