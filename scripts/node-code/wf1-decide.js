// Code node: "Decide Route" (Run Once for All Items)
// Applies the confidence gates and picks the route. Low confidence or no match => REVIEW (human queue).
const { cfg, reply, classification, llm } = $input.first().json;
const decision = decide(classification, cfg);

return [{
  json: {
    cfg,
    reply,
    classification,
    decision,
    llm: llm || { used: false, ok: false },
    hubspotLookup: cfg.hubspotEnabled && decision.route !== 'BOUNCE',
    lookupBody: buildContactLookupBody(reply.contact.email),
  },
}];
