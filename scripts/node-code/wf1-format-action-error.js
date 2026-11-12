// Code node: "Format Action Error" (Run Once for All Items)
// Failed live actions arrive here via each executor's error output. The alert never includes reply content.
let executionId = 'n/a';
try { executionId = $execution.id; } catch (e) { /* not available */ }

return $input.all().map((item) => {
  const action = item.json.action || {};
  const err = item.json.error || {};
  return {
    json: {
      payload: buildErrorPayload({
        workflowName: 'Reply Triage Router',
        nodeName: `action ${action.kind || 'unknown'}`,
        message: err.message || String(err) || 'Action failed',
        executionId,
        sandbox: false,
      }),
    },
  };
});
