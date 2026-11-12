// Code node: "Split Actions" (Run Once for All Items)
// One item per planned action. In live mode this also records out-of-office resume entries (workflow static data).
const d = $input.first().json;

if (!d.sandbox && d.plan.stateOps.length) {
  const state = $getWorkflowStaticData('global');
  state.resumeQueue = Array.isArray(state.resumeQueue) ? state.resumeQueue : [];
  for (const op of d.plan.stateOps) {
    if (op.op === 'enqueueResume') {
      state.resumeQueue = state.resumeQueue.filter((i) => i.key !== op.item.key).concat([op.item]).slice(-500);
    }
  }
}

return d.plan.actions.map((action) => ({ json: { sandbox: d.sandbox, replyId: d.replyId, outputIndex: action.outputIndex, action } }));
