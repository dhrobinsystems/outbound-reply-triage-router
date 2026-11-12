# Setup guide

> ⚠️ Use at your own risk — read [DISCLAIMER.md](../DISCLAIMER.md) first. Stay in `SANDBOX_MODE=true` until the go-live checklist below is complete.

## 1. Prerequisites

- n8n, preferably self-hosted. The workflows use only core nodes (Webhook, Schedule, Code, IF, Switch, HTTP Request, Respond to Webhook, Error Trigger, No-Op, Sticky Note).
- `N8N_BLOCK_ENV_ACCESS_IN_NODE=false` on your n8n instance. Newer n8n versions block env access in nodes by default. If you cannot change this, the Code nodes **fail safe** (defaults, sandbox ON) and you can hard-code non-secret settings in the `OVERRIDES` object at the top of *Load Config & Normalize* — but the HTTP nodes read secret URLs with `{{ $env.… }}`, so they will not work with env access blocked.
- Something that can POST replies to the webhook (see §5).
- Optional: HubSpot private-app token, Apollo API key, Slack incoming webhook, an OpenAI-compatible LLM endpoint.

## 2. Credentials (n8n)

No credential IDs ship in the workflow JSON. On import, map these placeholders to credentials you create:

| Placeholder | Type | Notes |
|---|---|---|
| `YOUR_WEBHOOK_AUTH_CREDENTIAL` | Header Auth | Required. Pick a header name (e.g. `X-Webhook-Secret`) and a long random value. The webhook fails closed without it |
| `YOUR_HUBSPOT_CREDENTIAL` | HubSpot App Token | Only if `HUBSPOT_ENABLED=true`. Start with read access (contact lookup) and add write access (tasks, opt-out) only when you go live. HubSpot errors name any missing scope |
| `YOUR_APOLLO_CREDENTIAL` | Header Auth | Only if `SEQUENCE_PROVIDER=apollo`. Verify the header name and key type in Apollo's API docs |
| `YOUR_LLM_CREDENTIAL` | Header Auth | Only if `ENABLE_LLM_FALLBACK=true` (e.g. `Authorization: Bearer …`) |

Credentials you do not use can stay unmapped, but n8n may warn on those nodes; the nodes are never reached unless the matching feature is enabled.

## 3. Environment variables

Copy [`.env.example`](../.env.example) into your n8n environment (Docker `-e`, compose `environment:`, or host env). Every value is a placeholder. Key points:

- `SANDBOX_MODE=true` — keep it.
- Each integration is opt-in: `SEQUENCE_PROVIDER` (`none` default), `HUBSPOT_ENABLED` (`false`), `SLACK_WEBHOOK_URL`, `SUPPRESSION_WEBHOOK_URL`, `ENABLE_LLM_FALLBACK` (`false`).
- Secret URLs (`SLACK_WEBHOOK_URL`, `SUPPRESSION_WEBHOOK_URL`, `SEQUENCE_WEBHOOK_URL`, `LLM_API_URL`) are read only by the HTTP nodes.
- `OWNER_SLACK_MAP_JSON` maps HubSpot owner IDs to Slack member IDs, e.g. `{"123456":"U0XXXXXXX"}`.

## 4. Import and wire up

1. Import `workflows/01-reply-triage-router.json` and `workflows/02-error-handler.json`.
2. Map credentials (§2).
3. Router → *Workflow settings* → **Error Workflow** → *Reply Triage - Error Handler*.
4. Leave both workflows **inactive** while testing.

## 5. Getting replies into the webhook

The router exposes `POST /webhook/reply-triage` (and `/webhook-test/reply-triage` while the editor listens). Header Auth is required. Send JSON matching [`schemas/reply-payload.schema.json`](../schemas/reply-payload.schema.json):

```json
{
  "replyId": "provider-message-id",
  "source": "generic",
  "receivedAt": "2026-11-10T14:00:00.000Z",
  "from": { "email": "person@example.com", "name": "Person" },
  "subject": "Re: your note",
  "body": "…plain-text reply…",
  "headers": { "Auto-Submitted": "auto-replied" },
  "contact": { "hubspotContactId": "123", "apolloContactId": "…" },
  "sequence": { "id": "…", "name": "…", "apolloSequenceId": "…" }
}
```

Ways to feed it: your mailbox/ESP's inbound-reply webhook, a Zap/Make/n8n workflow that forwards replies, or a HubSpot workflow "Send a webhook" action (requires a plan that includes it). Apollo- and HubSpot-style field names are accepted as aliases (`docs/sample-payloads/09-*`, `10-*`) but are **best-effort and unverified** — map to the generic shape if yours differ.

Include `headers` when you can: `Auto-Submitted`, `X-Autoreply`, `X-Autorespond`, and `Precedence: auto_reply` are strong out-of-office signals.

## 6. Dry run

1. In the router, click **Listen for test event** on *Reply Webhook*.
2. Send each sample:

   ```bash
   export WEBHOOK_URL="https://YOUR-N8N-HOST/webhook-test/reply-triage"
   export WEBHOOK_SECRET="…"
   export WEBHOOK_HEADER="X-Webhook-Secret"
   for f in docs/sample-payloads/*.json; do echo "== $f"; ./scripts/send-sample.sh "$f"; done
   ```

   (Click *Listen for test event* again before each call — the test URL accepts one request per listen.)
3. Check the JSON response: `label`, `confidence`, `route`, `reason`, `extracted`, `plannedActions`, `notes`.
4. Open **Dry Run: Actions Logged** to see the exact request each action would have sent. Confirm nothing reached HubSpot, Apollo, your webhooks, or Slack.
5. Compare against the routing table in the README.

## 7. Test against your own replies

Export 100+ historical replies (anonymize them before sharing anywhere), replay them in sandbox, and review: how many land in REVIEW? Which phrases are misrouted? Add them to `sample-data/labeled-replies.json` and tune `src/rules.js` (see [CLASSIFICATION.md](CLASSIFICATION.md)). Optionally enable the LLM fallback and compare.

## Go-live checklist

- [ ] Dry runs match the routing table for every sample payload
- [ ] Your own replies replayed; wrong-route rate is acceptable and REVIEW is staffed
- [ ] Opt-out path verified end to end: a test contact is actually suppressed in **every** system that can email them (HubSpot opt-out, your sending tool, suppression list)
- [ ] `APOLLO_STOP_MODE` is `stop` unless you intend permanent removal
- [ ] Credentials are least-privilege; webhook secret is long and not shared
- [ ] Error Workflow is set; Slack channel agreed; excerpt setting (`SLACK_INCLUDE_EXCERPT`) decided
- [ ] If LLM fallback is on: provider terms, data-processing agreement, and privacy notice checked
- [ ] Enable **one capability at a time**, then set `SANDBOX_MODE=false`, activate, and watch the first executions
- [ ] Keep a human on the REVIEW queue

## Troubleshooting

| Symptom | Likely cause |
|---|---|
| Webhook returns 403 / 401 | Missing or wrong Header Auth header |
| Webhook returns an error mentioning `valid sender email` / `reply body` | Payload does not match the schema |
| Everything lands in REVIEW | Replies are not English / unusual phrasing — add samples and tune, or enable the LLM fallback |
| Nothing is sent but Slack should fire | `SANDBOX_MODE` still on, or `SLACK_WEBHOOK_URL` unset (the plan lists a note) |
| Opt-out only produced a Slack "ACTION REQUIRED" | No suppression target configured (`HUBSPOT_ENABLED` + found contact, or `SUPPRESSION_WEBHOOK_URL`) |
| `Sequence not paused` note | `SEQUENCE_PROVIDER=none`, or Apollo IDs missing from the payload |
| `CRM task skipped` note | `HUBSPOT_ENABLED=false` or the contact was not found by email |
| Same reply processed twice | Sandbox runs don't record IDs (by design), or `replyId` changes between deliveries |
| Resume never fires | Resume queue is workflow static data: only saved by active production runs |
| `$env` access denied | `N8N_BLOCK_ENV_ACCESS_IN_NODE` (see §1) |
