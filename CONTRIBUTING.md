# Contributing

Issues and pull requests are welcome.

## Ground rules

- **Edit the sources, not the generated JSON.** Logic lives in `src/` (tested, dependency-free) and `scripts/node-code/` (thin n8n glue). `workflows/*.json` is generated:

  ```bash
  npm run build   # regenerate workflows/*.json
  npm run check   # CI: JSON is current, every Code node compiles, output is sanitized
  npm test        # unit tests + workflow simulation (real Code-node code, mocked HTTP)
  npm run eval    # classifier accuracy on the labeled samples
  ```

- Keep `src/` free of runtime dependencies (it is inlined into n8n Code nodes).
- Anything that writes to a CRM, touches a sequence, or posts to Slack must sit behind the `SANDBOX_MODE` gate.
- **Never commit** real secrets, webhook URLs, Slack/HubSpot IDs, personal emails, client names, or raw n8n exports. Sample data must use reserved domains (`example.com`, `example.org`, `acme.example`).
- Changing classification rules? Add examples to `sample-data/labeled-replies.json`, keep `sample-data/holdout-replies.json` untouched (it is only meaningful if it is never tuned on), and never let a change turn a REVIEW into a wrong action: the tests enforce zero wrong routes.

## Reporting problems

Include your n8n version, which node failed, and the error text with secrets and personal data removed. Never paste real replies.
