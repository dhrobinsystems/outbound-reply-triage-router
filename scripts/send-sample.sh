#!/usr/bin/env bash
# Send a sample payload to your n8n webhook. SANDBOX_MODE=true (default) makes this a dry run:
# you get the classification + planned actions back and nothing is sent, written, or paused.
#
#   export WEBHOOK_URL="https://YOUR-N8N-HOST/webhook-test/reply-triage"   # use /webhook-test/ while the editor is listening
#   export WEBHOOK_SECRET="the value of your Header Auth credential"
#   export WEBHOOK_HEADER="X-Webhook-Secret"                              # the header NAME you chose in that credential
#   ./scripts/send-sample.sh docs/sample-payloads/01-interested.json
set -euo pipefail

: "${WEBHOOK_URL:?Set WEBHOOK_URL (your n8n webhook URL)}"
: "${WEBHOOK_SECRET:?Set WEBHOOK_SECRET (Header Auth value)}"
HEADER_NAME="${WEBHOOK_HEADER:-X-Webhook-Secret}"
FILE="${1:?Usage: $0 path/to/payload.json}"

curl -sS -X POST "$WEBHOOK_URL" \
  -H "Content-Type: application/json" \
  -H "$HEADER_NAME: $WEBHOOK_SECRET" \
  --data @"$FILE"
echo
