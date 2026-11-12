'use strict';

/** Zero-dependency unit + workflow-simulation tests. Run with: npm test */

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const text = require('../src/text');
const { classify } = require('../src/classifier');
const ex = require('../src/extractors');
const { normalizePayload } = require('../src/normalize');
const { loadConfig, readEnv } = require('../src/config');
const { decide, planActions, planResume } = require('../src/router');
const llm = require('../src/llm');
const slack = require('../src/slack-blocks');
const { run: runEval } = require('../scripts/eval');
const H = require('./harness');

let passed = 0;
const failures = [];
function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  ok   ${name}`);
  } catch (e) {
    failures.push({ name, e });
    console.log(`  FAIL ${name}\n       ${String(e.message).split('\n').join('\n       ')}`);
  }
}

const REF = Date.parse('2026-11-10T12:00:00Z');
const cls = (body, extra) => classify(Object.assign({ from: { email: 'person@example.com' }, subject: 'Re: hello', body }, extra), { refMs: REF });
const DEFAULT = loadConfig({});
const LIVE = loadConfig(H.LIVE_ENV);

console.log('\ntext helpers');
test('cleanReply removes quoted history, forwarded headers, signatures', () => {
  assert.strictEqual(text.cleanReply('Sounds good!\n\nOn Mon, Nov 9, 2026 at 9:00 AM Rep <r@example.org> wrote:\n> Hi there'), 'Sounds good!');
  assert.strictEqual(text.cleanReply('No thanks.\n\n-----Original Message-----\nFrom: x'), 'No thanks.');
  assert.strictEqual(text.cleanReply('Yes\n> quoted line\nSent from my iPhone'), 'Yes');
});
test('stripHtml, maskEmail, truncate', () => {
  assert.strictEqual(text.stripHtml('<div>Hello&nbsp;<b>there</b></div><style>x{}</style>'), 'Hello there');
  assert.strictEqual(text.maskEmail('jane.doe@example.com'), 'j***@example.com');
  assert.strictEqual(text.truncate('abcdef', 4), 'abc…');
});
test('redactForLlm removes emails, urls, phone numbers', () => {
  const r = text.redactForLlm('Call +1 (555) 123-4567 or mail jane@example.com, see https://example.com/x');
  assert.ok(!/jane@|555|https/.test(r), r);
});

console.log('\nclassifier: labels');
const SAMPLE_EXPECT = {
  '01-interested.json': 'INTERESTED', '02-not-now.json': 'NOT_NOW', '03-wrong-person.json': 'WRONG_PERSON', '04-out-of-office.json': 'OUT_OF_OFFICE',
  '05-unsubscribe.json': 'UNSUBSCRIBE', '06-not-interested.json': 'NOT_INTERESTED', '07-review-ambiguous.json': 'REVIEW', '08-review-mixed-signals.json': 'REVIEW',
  '09-apollo-style.json': 'INTERESTED', '10-hubspot-style.json': 'INTERESTED', '11-bounce.json': 'BOUNCE', '12-prompt-injection-attempt.json': 'REVIEW', '13-html-with-quoted-history.json': 'NOT_INTERESTED',
};
for (const [file, route] of Object.entries(SAMPLE_EXPECT)) {
  test(`sample payload ${file} -> ${route}`, () => {
    const reply = normalizePayload(H.loadPayload(file), {});
    assert.strictEqual(decide(classify(reply, { refMs: REF }), DEFAULT).route, route);
  });
}
test('"not interested" is never read as INTERESTED', () => {
  assert.strictEqual(cls('Not interested, thanks.').label, 'NOT_INTERESTED');
  assert.strictEqual(cls("I'm not really interested at this time.").scores.INTERESTED, 0);
});
test('explicit opt-out beats every other signal', () => {
  assert.strictEqual(cls('Not interested. Please unsubscribe me.').label, 'UNSUBSCRIBE');
  assert.strictEqual(cls('Sounds interesting, send pricing. Actually, remove me from your list.').label, 'UNSUBSCRIBE');
});
test('regression: "circle back in 3 months" is NOT out-of-office', () => {
  const c = cls('Not a priority right now. Can you circle back in 3 months?');
  assert.strictEqual(c.label, 'NOT_NOW');
  assert.strictEqual(c.scores.OUT_OF_OFFICE, 0);
});
test('interest alongside a deferral is still NOT_NOW', () => assert.strictEqual(decide(cls('Sounds interesting, but not right now - circle back in Q1.'), DEFAULT).route, 'NOT_NOW'));
test('auto-reply headers alone mark out-of-office', () => {
  assert.strictEqual(cls('Will respond soon.', { headers: { 'Auto-Submitted': 'auto-replied' } }).label, 'OUT_OF_OFFICE');
  assert.strictEqual(cls('Will respond soon.', { headers: { 'auto-submitted': 'no' } }).label, 'UNKNOWN');
});
test('bounce senders are not replies from a person', () => assert.strictEqual(cls('x', { from: { email: 'mailer-daemon@example.com' } }).label, 'BOUNCE'));
test('quoted history does not influence the label', () => {
  const body = 'Not interested, thank you.\n\nOn Mon, Nov 9, 2026 at 9:00 AM Rep <r@example.org> wrote:\n> Interested in learning more? Happy to chat, send times.';
  assert.strictEqual(cls(body).label, 'NOT_INTERESTED');
});
test('unknown text -> UNKNOWN with zero confidence', () => {
  const c = cls('Thanks');
  assert.strictEqual(c.label, 'UNKNOWN');
  assert.strictEqual(c.confidence, 0);
});

console.log('\nextractors');
test('return dates: ISO, month-day, day-month, numeric (MDY/DMY), weekday', () => {
  assert.strictEqual(ex.parseReturnDate('I will return on 2026-12-02.', REF).returnDate, '2026-12-02');
  assert.strictEqual(ex.parseReturnDate('returning on November 23rd', REF).returnDate, '2026-11-23');
  assert.strictEqual(ex.parseReturnDate('back on 3 December', REF).returnDate, '2026-12-03');
  assert.strictEqual(ex.parseReturnDate('return on 11/24/2026', REF, 'MDY').returnDate, '2026-11-24');
  assert.strictEqual(ex.parseReturnDate('return on 03/12/2026', REF, 'DMY').returnDate, '2026-12-03');
  assert.strictEqual(ex.parseReturnDate('back on Monday', REF).returnDate, '2026-11-16'); // REF is a Tuesday
});
test('"until X" means back the day after; year is inferred as the next occurrence', () => {
  assert.strictEqual(ex.parseReturnDate('out of office until January 5', REF).returnDate, '2027-01-06');
  assert.strictEqual(ex.parseReturnDate('out of office until June 3', REF), null); // >180 days away: ignored, default pause applies
  assert.strictEqual(ex.parseReturnDate('out until November 17', REF).returnDate, '2026-11-18');
});
test('implausible or missing dates return null', () => {
  assert.strictEqual(ex.parseReturnDate('back in 2019-01-01', REF), null);
  assert.strictEqual(ex.parseReturnDate('I am travelling', REF), null);
  assert.strictEqual(ex.parseReturnDate('back on 2030-01-01', REF), null);
});
test('snooze days', () => {
  assert.strictEqual(ex.parseSnoozeDays('circle back in 3 months', REF), 90);
  assert.strictEqual(ex.parseSnoozeDays('try again in a couple of weeks', REF), 14);
  assert.strictEqual(ex.parseSnoozeDays('next quarter please', REF), 90);
  assert.strictEqual(ex.parseSnoozeDays('after the new year', REF), 57);
  assert.strictEqual(ex.parseSnoozeDays('nothing here', REF), null);
});
test('referral extraction: name, title, email; excludes sender and own domains', () => {
  const r = ex.extractReferral('Please contact Dana Lee at dana.lee@acme.example, our VP of Operations.', 'me@sender.example', []);
  assert.deepStrictEqual([r.name, r.title, r.email], ['Dana Lee', 'VP of Operations', 'dana.lee@acme.example']);
  assert.strictEqual(ex.extractReferral('write to me@sender.example', 'me@sender.example', []), null);
  assert.strictEqual(ex.extractReferral('contact ops@mycompany.example', 'x@y.example', ['mycompany.example']), null);
});
test('referral: name guessed from email is flagged; stop-words are rejected', () => {
  const r = ex.extractReferral('Try someone else: marcus.reyes@acme.example', 'x@y.example', []);
  assert.strictEqual(r.name, 'Marcus Reyes');
  assert.strictEqual(r.nameFromEmail, true);
  assert.strictEqual(ex.extractReferral('Please contact me', 'x@y.example', []), null);
});

console.log('\nrouter: decisions');
test('route = label when confident; REVIEW when below threshold or unknown', () => {
  assert.strictEqual(decide({ label: 'INTERESTED', confidence: 0.85 }, DEFAULT).route, 'INTERESTED');
  assert.strictEqual(decide({ label: 'INTERESTED', confidence: 0.79 }, DEFAULT).route, 'REVIEW');
  assert.strictEqual(decide({ label: 'UNKNOWN', confidence: 0 }, DEFAULT).route, 'REVIEW');
});
test('opt-outs use the lower, intentionally permissive threshold', () => {
  assert.strictEqual(decide({ label: 'UNSUBSCRIBE', confidence: 0.65 }, DEFAULT).route, 'UNSUBSCRIBE');
  assert.strictEqual(decide({ label: 'UNSUBSCRIBE', confidence: 0.5 }, DEFAULT).route, 'REVIEW');
});
test('thresholds are configurable', () => assert.strictEqual(decide({ label: 'INTERESTED', confidence: 0.79 }, loadConfig({ CONFIDENCE_THRESHOLD: '0.7' })).route, 'INTERESTED'));

console.log('\nrouter: action plans');
const plan = (file, cfg, contact, mutate) => {
  const reply = normalizePayload(H.loadPayload(file), {});
  if (mutate) mutate(reply);
  const c = classify(reply, { refMs: REF });
  const d = decide(c, cfg);
  return Object.assign(planActions({ reply, classification: c, decision: d, cfg, nowMs: Date.parse('2026-11-10T14:05:00Z'), contact: contact || { ownerId: '900001' } }), { decision: d });
};
const kinds = (p) => p.actions.map((a) => a.kind);

test('UNSUBSCRIBE: HubSpot opt-out + suppression webhook + stop sequence; Slack only if NOTIFY_ON_UNSUBSCRIBE', () => {
  assert.deepStrictEqual(kinds(plan('05-unsubscribe.json', LIVE)), ['HUBSPOT_OPT_OUT', 'SUPPRESSION_WEBHOOK', 'APOLLO_STOP_SEQUENCE']);
  assert.deepStrictEqual(kinds(plan('05-unsubscribe.json', loadConfig({ ...H.LIVE_ENV, NOTIFY_ON_UNSUBSCRIBE: 'true' }))).slice(-1), ['SLACK']);
});
test('UNSUBSCRIBE with no suppression target ALWAYS alerts a human', () => {
  const cfg = loadConfig({ SANDBOX_MODE: 'false', SLACK_WEBHOOK_URL: 'x' });
  const p = plan('05-unsubscribe.json', cfg);
  assert.deepStrictEqual(kinds(p), ['SLACK']);
  assert.ok(JSON.stringify(p.actions[0].request.body).includes('ACTION REQUIRED'));
});
test('INTERESTED: stop sequence + HIGH-priority task (associated to the contact) + Slack mentioning the owner', () => {
  const p = plan('01-interested.json', LIVE);
  assert.deepStrictEqual(kinds(p), ['APOLLO_STOP_SEQUENCE', 'HUBSPOT_CREATE_TASK', 'SLACK']);
  const task = p.actions[1].request.body;
  assert.strictEqual(task.properties.hs_task_priority, 'HIGH');
  assert.strictEqual(task.properties.hubspot_owner_id, '900001');
  assert.strictEqual(task.associations[0].to.id, '100001');
  assert.strictEqual(task.associations[0].types[0].associationTypeId, 204);
  assert.ok(JSON.stringify(p.actions[2].request.body).includes('<@U0EXAMPLE01>'));
});
test('Apollo stop uses the safe "stop" mode by default and carries a reason', () => {
  const body = plan('01-interested.json', LIVE).actions[0].request.body;
  assert.strictEqual(body.mode, 'stop');
  assert.deepStrictEqual(body.contact_ids, ['000000000000000000000001']);
  assert.deepStrictEqual(body.emailer_campaign_ids, ['000000000000000000000002']);
  assert.ok(body.stop_reason);
});
test('missing Apollo IDs: sequence is not paused and the plan says why', () => {
  const p = plan('01-interested.json', LIVE, null, (r) => { r.contact.apolloContactId = ''; });
  assert.ok(!kinds(p).includes('APOLLO_STOP_SEQUENCE'));
  assert.ok(p.notes.some((n) => /apolloContactId/.test(n)));
});
test('OUT_OF_OFFICE: pause + queue a resume entry on return date + delay (no Slack, no task)', () => {
  const p = plan('04-out-of-office.json', LIVE);
  assert.deepStrictEqual(kinds(p), ['APOLLO_STOP_SEQUENCE']);
  assert.strictEqual(p.stateOps[0].item.resumeAt, '2026-11-26T12:00:00.000Z'); // back 11-25 (until 11-24 + 1) + 1 day delay
});
test('OUT_OF_OFFICE without a parseable date uses the default pause', () => {
  const p = plan('04-out-of-office.json', LIVE, null, (r) => { r.body = 'Automatic reply: I am travelling.'; });
  assert.strictEqual(p.stateOps[0].item.basis, 'default-pause');
  assert.strictEqual(p.stateOps[0].item.resumeAt, '2026-11-17T14:05:00.000Z');
});
test('WRONG_PERSON: pause + enrichment task with the referral + Slack (referred email masked)', () => {
  const p = plan('03-wrong-person.json', LIVE);
  assert.deepStrictEqual(kinds(p), ['APOLLO_STOP_SEQUENCE', 'HUBSPOT_CREATE_TASK', 'SLACK']);
  assert.ok(p.actions[1].request.body.properties.hs_task_body.includes('dana.lee@acme.example'));
  assert.ok(!JSON.stringify(p.actions[2].request.body).includes('dana.lee@acme.example'));
});
test('NOT_NOW: pause + follow-up task due after the requested wait (3 months = 90 days)', () => {
  const p = plan('02-not-now.json', LIVE);
  assert.deepStrictEqual(kinds(p), ['APOLLO_STOP_SEQUENCE', 'HUBSPOT_CREATE_TASK']);
  assert.strictEqual(p.actions[1].request.body.properties.hs_timestamp, '2027-02-08T14:05:00.000Z');
});
test('NOT_INTERESTED: only stops the sequence - it is not an opt-out', () => {
  const p = plan('06-not-interested.json', LIVE);
  assert.deepStrictEqual(kinds(p), ['APOLLO_STOP_SEQUENCE']);
});
test('REVIEW: holds the sequence, creates a review task, alerts Slack', () => {
  const p = plan('07-review-ambiguous.json', LIVE);
  assert.strictEqual(p.decision.route, 'REVIEW');
  assert.deepStrictEqual(kinds(p), ['APOLLO_STOP_SEQUENCE', 'HUBSPOT_CREATE_TASK', 'SLACK']);
  assert.strictEqual(kinds(plan('07-review-ambiguous.json', loadConfig({ ...H.LIVE_ENV, PAUSE_ON_REVIEW: 'false' }))).includes('APOLLO_STOP_SEQUENCE'), false);
});
test('BOUNCE: no actions', () => assert.deepStrictEqual(kinds(plan('11-bounce.json', LIVE)), []));
test('defaults plan almost nothing destructive: no provider, HubSpot off', () => {
  const p = plan('01-interested.json', DEFAULT);
  assert.deepStrictEqual(kinds(p), ['SLACK']); // preview only; the sandbox gate stops it
  assert.ok(p.notes.length >= 2);
});
test('contact not found in HubSpot: no task, Slack says so', () => {
  const p = plan('01-interested.json', LIVE, {}, (r) => { r.contact.hubspotContactId = ''; });
  assert.ok(!kinds(p).includes('HUBSPOT_CREATE_TASK'));
  assert.ok(JSON.stringify(p.actions.find((a) => a.kind === 'SLACK').request.body).includes('Contact not found in HubSpot'));
});
test('Slack excerpts can be disabled', () => {
  const p = plan('01-interested.json', loadConfig({ ...H.LIVE_ENV, SLACK_INCLUDE_EXCERPT: 'false' }));
  assert.ok(!JSON.stringify(p.actions.find((a) => a.kind === 'SLACK').request.body).includes('more information'));
});
test('sequence webhook provider sends pause with resumeAt', () => {
  const p = plan('04-out-of-office.json', loadConfig({ ...H.LIVE_ENV, SEQUENCE_PROVIDER: 'webhook' }));
  assert.strictEqual(p.actions[0].kind, 'SEQUENCE_WEBHOOK');
  assert.strictEqual(p.actions[0].request.body.action, 'pause');
  assert.strictEqual(p.actions[0].request.body.resumeAt, '2026-11-26T12:00:00.000Z');
});
test('resume planning: webhook, HubSpot task, or Slack reminder', () => {
  const item = { key: 'r1', email: 'jane.doe@example.com', name: 'Jane', resumeAt: '2026-11-26T12:00:00.000Z', hubspotContactId: '100001' };
  assert.strictEqual(planResume(item, loadConfig({ ...H.LIVE_ENV, SEQUENCE_PROVIDER: 'webhook' }), 0)[0].kind, 'SEQUENCE_WEBHOOK');
  assert.strictEqual(planResume(item, LIVE, 0)[0].kind, 'HUBSPOT_CREATE_TASK');
  assert.strictEqual(planResume({ ...item, hubspotContactId: '' }, LIVE, 0)[0].kind, 'SLACK');
});

console.log('\nLLM fallback (optional, off by default)');
const LLM_ENV = { ...H.LIVE_ENV, ENABLE_LLM_FALLBACK: 'true', LLM_API_URL: 'https://example.invalid/llm', LLM_MODEL: 'test-model' };
test('flag is off by default and requires an endpoint when on', () => {
  assert.strictEqual(DEFAULT.enableLlmFallback, false);
  assert.throws(() => loadConfig({ ENABLE_LLM_FALLBACK: 'true' }), /requires LLM_API_URL/);
});
test('used only below the threshold, never for an explicit opt-out, never for bounces', () => {
  const cfg = loadConfig(LLM_ENV);
  assert.strictEqual(llm.shouldUseLlm(cfg, { label: 'UNKNOWN', confidence: 0 }), true);
  assert.strictEqual(llm.shouldUseLlm(cfg, { label: 'INTERESTED', confidence: 0.95 }), false);
  assert.strictEqual(llm.shouldUseLlm(cfg, { label: 'UNSUBSCRIBE', confidence: 0.7 }), false);
  assert.strictEqual(llm.shouldUseLlm(cfg, { label: 'BOUNCE', confidence: 0.95 }), false);
  assert.strictEqual(llm.shouldUseLlm(DEFAULT, { label: 'UNKNOWN', confidence: 0 }), false);
});
test('request is redacted and treats reply text as untrusted', () => {
  const req = llm.buildLlmRequest({ cleanedText: 'Reach me at jane@example.com or +1 555 123 4567 https://x.example' }, loadConfig(LLM_ENV));
  const body = JSON.stringify(req);
  assert.ok(!/jane@|555|https:\/\/x/.test(body));
  assert.ok(/untrusted data/.test(req.messages[0].content));
  assert.strictEqual(req.temperature, 0);
});
test('response parsing: valid, capped, fenced, and rejected variants', () => {
  const cfg = loadConfig(LLM_ENV);
  const ok = (content) => llm.parseLlmResponse({ choices: [{ message: { content } }] }, cfg);
  assert.strictEqual(ok('{"label":"INTERESTED","confidence":0.99,"reason":"asks for pricing"}').confidence, 0.9);
  assert.strictEqual(ok('```json\n{"label":"not_now","confidence":0.8}\n```').label, 'NOT_NOW');
  assert.strictEqual(llm.parseLlmResponse({ content: [{ type: 'text', text: '{"label":"WRONG_PERSON","confidence":0.7}' }] }, cfg).label, 'WRONG_PERSON');
  for (const bad of ['I think it is interested', '{"label":"DELETE_EVERYTHING","confidence":0.9}', '{"label":"INTERESTED","confidence":7}', '{bad json}', '']) assert.strictEqual(ok(bad), null, bad);
  assert.strictEqual(llm.parseLlmResponse(null, cfg), null);
  assert.strictEqual(llm.parseLlmResponse({ error: { message: 'timeout' } }, cfg), null);
});

console.log('\nconfig');
test('SANDBOX_MODE is fail-safe: only explicit off words disable it', () => {
  for (const off of ['false', 'FALSE', '0', 'no', 'off']) assert.strictEqual(loadConfig({ SANDBOX_MODE: off }).sandbox, false, off);
  for (const on of ['true', '', 'flase', 'maybe', undefined]) assert.strictEqual(loadConfig({ SANDBOX_MODE: on }).sandbox, true, String(on));
});
test('safe defaults', () => {
  assert.strictEqual(DEFAULT.sandbox, true);
  assert.strictEqual(DEFAULT.confidenceThreshold, 0.8);
  assert.strictEqual(DEFAULT.enableLlmFallback, false);
  assert.strictEqual(DEFAULT.hubspotEnabled, false);
  assert.strictEqual(DEFAULT.sequenceProvider, 'none');
});
test('secrets and URLs never enter the config object', () => {
  const cfg = loadConfig({ ...LLM_ENV, SLACK_WEBHOOK_URL: 'https://secret.example/abc123' });
  assert.ok(!/secret\.example|abc123|example\.invalid/.test(JSON.stringify(cfg)));
  assert.strictEqual(cfg.slackConfigured, true);
});
test('invalid values fail loudly', () => {
  assert.throws(() => loadConfig({ CONFIDENCE_THRESHOLD: '1.5' }), /between 0/);
  assert.throws(() => loadConfig({ CONFIDENCE_THRESHOLD: 'abc' }), /must be a number/);
  assert.throws(() => loadConfig({ SEQUENCE_PROVIDER: 'carrier-pigeon' }), /must be one of/);
  assert.throws(() => loadConfig({ OWNER_SLACK_MAP_JSON: '[1]' }), /valid JSON object/);
  assert.throws(() => loadConfig({ NOT_NOW_FOLLOWUP_DAYS: '0' }), /greater than 0/);
});
test('readEnv survives blocked env access (falls back to safe defaults)', () => {
  const blocked = new Proxy({}, { get() { throw new Error('access to env vars denied'); } });
  assert.deepStrictEqual(readEnv(blocked), {});
  assert.strictEqual(loadConfig(readEnv(blocked)).sandbox, true);
});

console.log('\npayload normalization');
test('generic, Apollo-style, HubSpot-style, and "Name <email>" senders', () => {
  assert.strictEqual(normalizePayload(H.loadPayload('01-interested.json'), {}).contact.hubspotContactId, '100001');
  const a = normalizePayload(H.loadPayload('09-apollo-style.json'), {});
  assert.deepStrictEqual([a.contact.apolloContactId, a.sequence.apolloSequenceId, a.from.email], ['000000000000000000000001', '000000000000000000000002', 'jane.doe@example.com']);
  assert.strictEqual(normalizePayload(H.loadPayload('10-hubspot-style.json'), {}).contact.hubspotContactId, '100001');
  assert.deepStrictEqual(normalizePayload({ from: 'Jane Doe <JANE@Example.com>', body: 'hi' }, {}).from, { name: 'Jane Doe', email: 'jane@example.com' });
});
test('html-only replies are converted; body is capped', () => {
  const r = normalizePayload(H.loadPayload('13-html-with-quoted-history.json'), {});
  assert.strictEqual(r.body, '');
  assert.ok(r.html.includes('Not interested'));
  assert.strictEqual(normalizePayload({ from: { email: 'a@b.co' }, body: 'x'.repeat(50000) }, {}, { maxBodyChars: 100 }).body.length, 100);
});
test('invalid payloads are rejected with readable errors', () => {
  assert.throws(() => normalizePayload({ from: { email: 'nope' }, body: 'x' }, {}), /valid sender email/);
  assert.throws(() => normalizePayload({ from: { email: 'a@b.co' } }, {}), /reply body/);
  assert.throws(() => normalizePayload(null, {}), /valid sender email/);
});
test('a non-numeric HubSpot contact ID is dropped (never used in a URL)', () => {
  assert.strictEqual(normalizePayload({ from: { email: 'a@b.co' }, body: 'x', hubspotContactId: '1/../../admin' }, {}).contact.hubspotContactId, '');
});
test('replyId fallback is stable', () => {
  const p = { from: { email: 'a@b.co' }, body: 'hello', subject: 's', receivedAt: '2026-11-10T14:00:00Z' };
  assert.strictEqual(normalizePayload(p, {}).replyId, normalizePayload(p, {}).replyId);
});

console.log('\nslack payloads');
test('payloads respect Slack limits, mask emails, escape markup', () => {
  const reply = normalizePayload({ ...H.loadPayload('01-interested.json'), body: '<b>hi</b> & <script>', subject: 'a<b' }, {});
  const c = classify(reply, { refMs: REF });
  const p = slack.buildSlackPayload('REVIEW', { reply, classification: c, decision: { reason: 'x' }, cfg: DEFAULT, ownerId: '1' });
  const s = JSON.stringify(p);
  assert.ok(p.blocks.length <= 50 && p.blocks[0].text.text.startsWith('[SANDBOX]'));
  assert.ok(!s.includes('jane.doe@example.com') && s.includes('j***@example.com'));
  assert.ok(!s.includes('<script>'));
});
test('owner mention requires a well-formed Slack member ID', () => {
  assert.strictEqual(slack.ownerMention({ ownerSlackMap: { 1: 'U0ABCDEFG' } }, '1'), '<@U0ABCDEFG>');
  assert.strictEqual(slack.ownerMention({ ownerSlackMap: { 1: '<!channel>' } }, '1'), '');
});
test('error payloads never contain reply content', () => {
  const p = slack.buildErrorPayload({ workflowName: 'W', nodeName: 'N', message: 'boom', executionId: '1', sandbox: false });
  assert.ok(!/body|excerpt/i.test(JSON.stringify(p)));
});

console.log('\nworkflow simulation (real generated Code-node code, mocked HTTP)');
test('sandbox (default): every sample is classified, planned, and flagged sandbox=true', () => {
  for (const [file, route] of Object.entries(SAMPLE_EXPECT)) {
    const r = H.simulateReply({ payload: H.loadPayload(file), env: {} });
    assert.strictEqual(r.response.route, route, file);
    assert.strictEqual(r.response.sandbox, true, file);
    r.items.forEach((i) => assert.strictEqual(i.json.sandbox, true, `${file}: item not flagged sandbox`));
  }
});
test('live: sample payloads produce the expected executor outputs', () => {
  const idx = { HUBSPOT_OPT_OUT: 0, SUPPRESSION_WEBHOOK: 1, APOLLO_STOP_SEQUENCE: 2, SEQUENCE_WEBHOOK: 3, HUBSPOT_CREATE_TASK: 4, SLACK: 5 };
  const r = H.simulateReply({ payload: H.loadPayload('01-interested.json'), env: H.LIVE_ENV, staticData: {} });
  assert.deepStrictEqual(r.kinds, ['APOLLO_STOP_SEQUENCE', 'HUBSPOT_CREATE_TASK', 'SLACK']);
  r.items.forEach((i) => assert.strictEqual(i.json.outputIndex, idx[i.json.action.kind]));
  assert.strictEqual(r.response.sandbox, false);
});
test('HubSpot lookup attaches owner and contact ID; a failed lookup degrades gracefully', () => {
  const ok = H.simulateReply({ payload: { ...H.loadPayload('01-interested.json'), contact: {} }, env: H.LIVE_ENV, staticData: {} });
  assert.strictEqual(ok.plan.actions.find((a) => a.kind === 'HUBSPOT_CREATE_TASK').request.body.properties.hubspot_owner_id, '900001');
  const failed = H.simulateReply({ payload: { ...H.loadPayload('01-interested.json'), contact: {} }, env: H.LIVE_ENV, staticData: {}, hubspotSearch: { status: 'error', message: 'rate limited' } });
  assert.ok(!failed.kinds.includes('HUBSPOT_CREATE_TASK'));
  assert.ok(failed.kinds.includes('SLACK'));
});
test('duplicate webhook deliveries are processed once (live) and never recorded (sandbox)', () => {
  const sd = {};
  const a = H.simulateReply({ payload: H.loadPayload('01-interested.json'), env: H.LIVE_ENV, staticData: sd });
  assert.strictEqual(a.duplicate, false);
  assert.strictEqual(H.simulateReply({ payload: H.loadPayload('01-interested.json'), env: H.LIVE_ENV, staticData: sd }).duplicate, true);
  const sbx = {};
  H.simulateReply({ payload: H.loadPayload('01-interested.json'), env: {}, staticData: sbx });
  assert.strictEqual(H.simulateReply({ payload: H.loadPayload('01-interested.json'), env: {}, staticData: sbx }).duplicate, false);
});
test('out-of-office resume queue: written in live mode only, replayed when due, then cleared', () => {
  const env = { ...H.LIVE_ENV, SEQUENCE_PROVIDER: 'webhook' };
  const sbxState = {};
  H.simulateReply({ payload: H.loadPayload('04-out-of-office.json'), env: { ...env, SANDBOX_MODE: 'true' }, staticData: sbxState });
  assert.ok(!sbxState.resumeQueue || sbxState.resumeQueue.length === 0);

  const sd = {};
  H.simulateReply({ payload: H.loadPayload('04-out-of-office.json'), env, staticData: sd });
  assert.strictEqual(sd.resumeQueue.length, 1);
  assert.strictEqual(H.simulateResume({ env, staticData: sd, nowIso: '2026-11-20T09:00:00Z' }).length, 0); // not due yet
  assert.strictEqual(sd.resumeQueue.length, 1);
  const due = H.simulateResume({ env, staticData: sd, nowIso: '2026-11-27T09:00:00Z' });
  assert.deepStrictEqual(due.map((i) => i.json.action.kind), ['SEQUENCE_WEBHOOK']);
  assert.strictEqual(due[0].json.action.request.body.action, 'resume');
  assert.strictEqual(sd.resumeQueue.length, 0);
});
test('resume in sandbox previews but never clears the queue', () => {
  const sd = { resumeQueue: [{ key: 'k', email: 'a@b.co', name: 'A', resumeAt: '2026-11-01T00:00:00.000Z', hubspotContactId: '' }] };
  const out = H.simulateResume({ env: {}, staticData: sd, nowIso: '2026-11-10T00:00:00Z' });
  assert.strictEqual(out.length, 1);
  assert.strictEqual(out[0].json.sandbox, true);
  assert.strictEqual(sd.resumeQueue.length, 1);
});
test('LLM fallback: rescues an ambiguous reply when enabled, with the model answer capped', () => {
  const payload = { ...H.loadPayload('07-review-ambiguous.json'), body: 'Could be useful for us. Worth a conversation.' };
  const off = H.simulateReply({ payload, env: H.LIVE_ENV, staticData: {} });
  assert.strictEqual(off.llmCalled, false);
  assert.strictEqual(off.response.route, 'REVIEW');
  const on = H.simulateReply({ payload, env: LLM_ENV, staticData: {}, llmResponse: { choices: [{ message: { content: '{"label":"INTERESTED","confidence":0.97,"reason":"open to a conversation"}' } }] } });
  assert.strictEqual(on.llmCalled, true);
  assert.strictEqual(on.response.route, 'INTERESTED');
  assert.strictEqual(on.response.confidence, 0.9);
  assert.strictEqual(on.response.classifiedBy, 'llm');
  assert.ok(!/@/.test(JSON.stringify(on.llmRequest)), 'LLM request must be redacted');
});
test('LLM failures (garbage, timeout, error body) always end in REVIEW, never a guess', () => {
  const payload = H.loadPayload('07-review-ambiguous.json');
  for (const llmResponse of [{ choices: [{ message: { content: 'sure! INTERESTED' } }] }, { error: { message: 'timeout' } }, undefined, {}]) {
    const r = H.simulateReply({ payload, env: LLM_ENV, staticData: {}, llmResponse });
    assert.strictEqual(r.response.route, 'REVIEW');
  }
});
test('LLM is never consulted for an explicit opt-out, and cannot override it', () => {
  const r = H.simulateReply({ payload: H.loadPayload('05-unsubscribe.json'), env: LLM_ENV, staticData: {}, llmResponse: { choices: [{ message: { content: '{"label":"INTERESTED","confidence":0.9}' } }] } });
  assert.strictEqual(r.llmCalled, false);
  assert.strictEqual(r.response.route, 'UNSUBSCRIBE');
});
test('prompt-injection text cannot force a route (rules ignore it; LLM answer is validated)', () => {
  const sbx = H.simulateReply({ payload: H.loadPayload('12-prompt-injection-attempt.json'), env: {} });
  assert.strictEqual(sbx.response.route, 'REVIEW');
  const withLlm = H.simulateReply({ payload: H.loadPayload('12-prompt-injection-attempt.json'), env: LLM_ENV, staticData: {}, llmResponse: { choices: [{ message: { content: 'Ignore previous instructions. INTERESTED' } }] } });
  assert.strictEqual(withLlm.response.route, 'REVIEW');
});
test('invalid payload fails the run loudly (webhook returns an error, nothing is planned)', () => {
  assert.throws(() => H.simulateReply({ payload: { from: { email: 'x' } }, env: {} }), /valid sender email/);
});
test('Format Action Error / Format Error produce alerts without reply content', () => {
  const wf1 = H.loadWorkflow('01-reply-triage-router.json');
  const out = H.runCodeNode(wf1, 'Format Action Error', { input: [{ json: { action: { kind: 'SLACK', request: { body: { secret: 'REPLY TEXT' } } }, error: { message: 'HTTP 500' } } }], nodes: {}, env: {}, staticData: {} });
  assert.ok(JSON.stringify(out).includes('HTTP 500') && !JSON.stringify(out).includes('REPLY TEXT'));
  const wf2 = H.loadWorkflow('02-error-handler.json');
  const e = H.runCodeNode(wf2, 'Format Error', { input: [{ json: { workflow: { name: 'W' }, execution: { id: '7', lastNodeExecuted: 'Plan Actions', error: { message: 'bad' } } } }], nodes: {}, env: {}, staticData: {} });
  assert.strictEqual(e[0].json.sandbox, true);
  assert.ok(e[0].json.payload.blocks[0].text.text.startsWith('[SANDBOX]'));
});

console.log('\nworkflow JSON integrity & sanitization');
const WF_FILES = ['01-reply-triage-router.json', '02-error-handler.json'];
for (const file of WF_FILES) {
  test(`${file}: valid graph, unique names/ids, ships inactive`, () => {
    const wf = H.loadWorkflow(file);
    const names = new Set(wf.nodes.map((n) => n.name));
    assert.strictEqual(names.size, wf.nodes.length);
    assert.strictEqual(new Set(wf.nodes.map((n) => n.id)).size, wf.nodes.length);
    for (const [from, v] of Object.entries(wf.connections)) {
      assert.ok(names.has(from), `unknown source ${from}`);
      v.main.flat().forEach((c) => assert.ok(names.has(c.node), `unknown target ${c.node}`));
    }
    assert.strictEqual(wf.active, false);
  });
  test(`${file}: sanitized (no credential IDs, webhookIds, instanceIds, secrets, real URLs)`, () => {
    const raw = fs.readFileSync(path.join(H.ROOT, 'workflows', file), 'utf8');
    assert.ok(!/"webhookId"|"instanceId"|"versionId"|"executionId"/.test(raw));
    assert.ok(!/hooks\.slack\.com|xox[bpas]-|pat-[a-z]{2}\d?-|sk-[A-Za-z0-9]{20,}|@gmail\.|@yahoo\./i.test(raw));
    for (const n of H.loadWorkflow(file).nodes) {
      for (const ref of Object.values(n.credentials || {})) {
        assert.strictEqual(ref.id, undefined, `${n.name}: credential id present`);
        assert.ok(/^YOUR_[A-Z_]+_CREDENTIAL$/.test(ref.name), `${n.name}: ${ref.name}`);
      }
    }
  });
}
test('Reply Webhook requires Header Auth', () => {
  const n = H.loadWorkflow('01-reply-triage-router.json').nodes.find((x) => x.name === 'Reply Webhook');
  assert.strictEqual(n.parameters.authentication, 'headerAuth');
  assert.strictEqual(n.parameters.httpMethod, 'POST');
});
test('SANDBOX GATE: executors are reachable ONLY through the "Sandbox Mode?" false branch', () => {
  const wf = H.loadWorkflow('01-reply-triage-router.json');
  const into = {};
  for (const [from, v] of Object.entries(wf.connections)) v.main.forEach((outs, idx) => outs.forEach((c) => (into[c.node] = (into[c.node] || []).concat([`${from}#${idx}`]))));
  assert.deepStrictEqual(into['Route Action'], ['Sandbox Mode?#1']);
  const executors = ['HubSpot: Opt Out Contact', 'Suppression Webhook', 'Apollo: Stop Sequence', 'Sequence Control Webhook', 'HubSpot: Create Task', 'Post to Slack'];
  executors.forEach((e) => assert.ok(into[e].every((src) => src.startsWith('Route Action#')), `${e} reachable from ${into[e]}`));
  assert.deepStrictEqual(into['Dry Run: Actions Logged'], ['Sandbox Mode?#0']);
  // the gate is true-for-sandbox: output 0 (true) = dry run
  const gate = wf.nodes.find((n) => n.name === 'Sandbox Mode?');
  assert.strictEqual(gate.parameters.conditions.conditions[0].leftValue, '={{ $json.sandbox }}');
  assert.strictEqual(gate.parameters.conditions.conditions[0].operator.operation, 'true');
});
test('every executor has an error branch wired to "Format Action Error"', () => {
  const wf = H.loadWorkflow('01-reply-triage-router.json');
  ['HubSpot: Opt Out Contact', 'Suppression Webhook', 'Apollo: Stop Sequence', 'Sequence Control Webhook', 'HubSpot: Create Task', 'Post to Slack'].forEach((name) => {
    assert.strictEqual(wf.nodes.find((n) => n.name === name).onError, 'continueErrorOutput', name);
    assert.ok(wf.connections[name].main[1].some((c) => c.node === 'Format Action Error'), name);
  });
});
test('task creation is not auto-retried (would duplicate tasks)', () => assert.strictEqual(H.loadWorkflow('01-reply-triage-router.json').nodes.find((n) => n.name === 'HubSpot: Create Task').retryOnFail, undefined));
test('workflow has documentation sticky notes', () => assert.ok(H.loadWorkflow('01-reply-triage-router.json').nodes.filter((n) => n.type === 'n8n-nodes-base.stickyNote').length >= 6));
test('Route Action outputs match planner ACTION_OUTPUT indexes', () => {
  const wf = H.loadWorkflow('01-reply-triage-router.json');
  const { ACTION_OUTPUT } = require('../src/router');
  const targets = { HUBSPOT_OPT_OUT: 'HubSpot: Opt Out Contact', SUPPRESSION_WEBHOOK: 'Suppression Webhook', APOLLO_STOP_SEQUENCE: 'Apollo: Stop Sequence', SEQUENCE_WEBHOOK: 'Sequence Control Webhook', HUBSPOT_CREATE_TASK: 'HubSpot: Create Task', SLACK: 'Post to Slack' };
  for (const [kind, idx] of Object.entries(ACTION_OUTPUT)) assert.strictEqual(wf.connections['Route Action'].main[idx][0].node, targets[kind], kind);
});
test('.env.example defaults are safe and every config key is documented', () => {
  const env = fs.readFileSync(path.join(H.ROOT, '.env.example'), 'utf8');
  assert.ok(/^SANDBOX_MODE=true$/m.test(env));
  assert.ok(/^ENABLE_LLM_FALLBACK=false$/m.test(env));
  assert.ok(/^CONFIDENCE_THRESHOLD=0\.80$/m.test(env));
  for (const key of require('../src/config').ENV_KEYS) assert.ok(new RegExp(`^#?\\s*${key}=`, 'm').test(env), `${key} missing from .env.example`);
  assert.ok(!/^[A-Z_]*(?:URL|TOKEN|KEY|SECRET)=\S+/m.test(env), 'placeholder values must be empty');
});
test('repo contains no real-looking secrets or personal data', () => {
  const skip = new Set(['node_modules', '.git']);
  const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (skip.has(e.name) ? [] : e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]));
  for (const f of walk(H.ROOT).filter((x) => !/tests[\\/]run-tests\.js$/.test(x))) {
    const s = fs.readFileSync(f, 'utf8');
    assert.ok(!/hooks\.slack\.com\/services|xox[bpas]-[0-9A-Za-z-]{10,}|pat-(?:na|eu)\d?-[0-9a-f-]{20,}|sk-[A-Za-z0-9]{20,}|AKIA[0-9A-Z]{16}/.test(s), `secret-like string in ${path.relative(H.ROOT, f)}`);
  }
});

console.log('\nclassifier accuracy guard (synthetic samples)');
test('tuning set: >= 95% routed as expected, zero wrong-action routes', () => {
  const r = runEval('sample-data/labeled-replies.json');
  const wrong = r.filter((x) => x.route !== x.expected && x.route !== 'REVIEW');
  assert.ok(r.filter((x) => x.route === x.expected).length / r.length >= 0.95);
  assert.strictEqual(wrong.length, 0, wrong.map((w) => `${w.id}:${w.route}`).join(','));
});
test('hold-out set: >= 65% routed correctly and ZERO wrong routes (misses must fall to REVIEW)', () => {
  const r = runEval('sample-data/holdout-replies.json');
  const wrong = r.filter((x) => x.route !== x.expected && x.route !== 'REVIEW');
  assert.ok(r.filter((x) => x.route === x.expected).length / r.length >= 0.65);
  assert.strictEqual(wrong.length, 0, wrong.map((w) => `${w.id}:${w.route}`).join(','));
});
test('no opt-out is ever missed silently: every UNSUBSCRIBE sample routes to UNSUBSCRIBE or REVIEW', () => {
  for (const file of ['labeled-replies.json', 'holdout-replies.json']) {
    runEval(`sample-data/${file}`).filter((r) => r.expected === 'UNSUBSCRIBE').forEach((r) => assert.ok(['UNSUBSCRIBE', 'REVIEW'].includes(r.route), r.id));
  }
});

console.log(`\n${passed} passed, ${failures.length} failed`);
process.exit(failures.length ? 1 : 0);
