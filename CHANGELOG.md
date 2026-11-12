# Changelog

## 1.0.0

- Deterministic reply classifier (Unsubscribe, Interested, Not Now, Not Interested, Wrong Person, Out of Office, Bounce) with noisy-OR scoring and a confidence gate.
- Out-of-office return-date parsing with delayed re-enrollment queue; "not now" snooze parsing; wrong-person referral extraction.
- Optional LLM fallback behind `ENABLE_LLM_FALLBACK` (redacted input, validated + capped output, never used for explicit opt-outs).
- Human-review queue (Slack + CRM task) for low-confidence replies.
- Sandbox-by-default (`SANDBOX_MODE=true`, fail-safe) gate in front of every write; per-executor error branches; error-handler workflow.
- Sanitized, import-ready n8n workflows; 13 sample payloads; JSON schema; labeled sample corpus + hold-out; 94 automated checks.
