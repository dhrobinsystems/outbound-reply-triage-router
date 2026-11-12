// Code node: "Merge LLM Result" (Run Once for All Items)
// Validates the model's answer. Anything malformed, unknown, or over-confident is ignored or capped,
// and the lower-confidence rules result continues to the human-review path.
const prior = $('Classify (Rules)').first().json;
const parsed = parseLlmResponse($input.first().json, prior.cfg);

let classification = prior.classification;
if (parsed && parsed.label !== 'UNKNOWN') {
  const text = `${prior.reply.subject}\n${classification.cleanedText}`;
  classification = Object.assign({}, classification, {
    label: parsed.label,
    confidence: parsed.confidence,
    source: 'llm',
    llmReason: parsed.reason,
    extracted: extractFor(parsed.label, text, classification.cleanedText, prior.reply.from.email, {
      dateFormat: prior.cfg.dateFormat,
      ownDomains: prior.cfg.ownDomains,
      refMs: Date.parse(prior.reply.receivedAt),
    }),
  });
}

return [{ json: { cfg: prior.cfg, reply: prior.reply, classification, llm: { used: true, ok: Boolean(parsed) } } }];
