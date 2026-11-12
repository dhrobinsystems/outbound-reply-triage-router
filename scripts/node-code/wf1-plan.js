// Code node: "Plan Actions" (Run Once for All Items)
// Builds the list of side effects for this reply. Nothing is executed here - the Sandbox gate decides that later.
const d = $input.first().json;
const plan = planActions({
  reply: d.reply,
  classification: d.classification,
  decision: d.decision,
  cfg: d.cfg,
  nowMs: Date.now(),
  contact: d.contact,
});

return [{
  json: {
    sandbox: d.cfg.sandbox,
    replyId: d.reply.replyId,
    plan,
    response: {
      status: 'accepted',
      sandbox: d.cfg.sandbox,
      replyId: d.reply.replyId,
      label: d.classification.label,
      confidence: d.classification.confidence,
      classifiedBy: d.classification.source,
      route: d.decision.route,
      reason: d.decision.reason,
      extracted: d.classification.extracted,
      plannedActions: plan.actions.map((a) => a.kind),
      notes: plan.notes,
    },
  },
}];
