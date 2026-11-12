// Code node: "Classify (Rules)" (Run Once for All Items)
// Deterministic regex/rule classification. No network, no LLM. Decides whether the optional LLM fallback is needed.
const { cfg, reply } = $input.first().json;
const classification = classify(reply, {
  dateFormat: cfg.dateFormat,
  ownDomains: cfg.ownDomains,
  refMs: Date.parse(reply.receivedAt),
});
const needsLlm = shouldUseLlm(cfg, classification);

return [{ json: { cfg, reply, classification, needsLlm, llmRequest: needsLlm ? buildLlmRequest(classification, cfg) : null } }];
