# Classification guide

## Pipeline

1. **Clean the text.** HTML is stripped; quoted history (`On … wrote:`, `> lines`, `-----Original Message-----`, forwarded headers) and mobile signatures are removed. Only what the person wrote is classified.
2. **System senders.** `mailer-daemon@` / `postmaster@` senders and delivery-failure subjects → `BOUNCE` (ignored).
3. **Rules.** Every rule in `src/rules.js` is tested against `subject + cleaned body`. INTERESTED rules run on a copy of the text with explicit negations removed ("not interested", "interested in principle"). Auto-reply headers add an OUT_OF_OFFICE signal (0.9).
4. **Scoring.** Per label, matched rule weights combine with noisy-OR: `score = 1 − ∏(1 − wᵢ)`. Two 0.85 rules give 0.978.
5. **Opt-out override.** If any UNSUBSCRIBE rule with weight ≥ 0.9 matched, the label is UNSUBSCRIBE regardless of other signals.
6. **Confidence.** Otherwise the top label wins and `confidence = top × (1 − penalty × max(0, second − 0.3))`. The default penalty is 0.5; `NOT_NOW` beating `INTERESTED` uses 0.2 ("interested, but not now" is still NOT_NOW) and `OUT_OF_OFFICE` beating `NOT_NOW` uses 0.1 ("out until June 3"). Replies over 1,500 characters are multiplied by 0.9.
7. **Extraction** for the winning label: return date (OUT_OF_OFFICE), snooze length (NOT_NOW), referred contact (WRONG_PERSON).
8. **Decision** (`src/router.js → decide`): UNSUBSCRIBE needs ≥ `UNSUBSCRIBE_CONFIDENCE_THRESHOLD`; everything else needs ≥ `CONFIDENCE_THRESHOLD`; otherwise **REVIEW**.
9. **Optional LLM fallback** only when the result is below threshold, the flag is on, and it is not an explicit opt-out.

## Extractors

| Extractor | Understands | Limits |
|---|---|---|
| Return date | `2026-12-02`, `November 23rd`, `3 December`, `11/24/2026` (MDY or DMY via `DATE_FORMAT_PREFERENCE`), `back on Monday`; "until X" means back the next day | Dates without a year resolve to the next occurrence; dates > 180 days away or in the past are ignored (default pause applies); relative phrases ("in two weeks") are not parsed |
| Snooze length | `in 3 months`, `a couple of weeks`, `next quarter`, `after the new year`, `Q3` | Capped at 365 days; otherwise `NOT_NOW_FOLLOWUP_DAYS` |
| Referred contact | name after "contact / reach out to / speak with / try / cc'd / looping in…", title (VP, Director, Head of …, C-level), first non-sender email | Best-effort. A name guessed from an email local part is flagged; own domains (`OWN_EMAIL_DOMAINS`) are excluded. Always verify before enrichment |

## Tuning workflow

```bash
npm run eval -- --verbose      # per-class recall/precision and every miss
```

1. Add real (anonymized) replies with the label you *expect the route to be* to `sample-data/labeled-replies.json`.
2. Edit weights or add rules in `src/rules.js`. Prefer general phrase families over one-off phrases.
3. `npm run eval` and `npm test`. The tests require **zero wrong routes** on both sets: a miss must fall to REVIEW, never to a wrong action.
4. Leave `sample-data/holdout-replies.json` alone. It is only a meaningful estimate of unseen phrasing if it is never tuned on. When you want a new estimate, write a fresh hold-out.
5. `npm run build` to regenerate the workflow JSON, then re-import it.

Rule of thumb for weights: ≥ 0.9 means "this phrase alone is decisive"; 0.7–0.85 "strong"; ≤ 0.6 "supporting evidence only" (alone it will not clear the 0.80 threshold, which is deliberate).

## Why some replies go to review on purpose

- A bare "I forwarded this to X" could be a positive hand-off or a wrong-person reply.
- "Sounds interesting" alone (0.55) is polite-sounding but not an action signal.
- Short or unfamiliar replies ("Thanks", "Who is this?") carry no signal.

These are exactly the cases where a human, or the optional LLM fallback, adds value.
