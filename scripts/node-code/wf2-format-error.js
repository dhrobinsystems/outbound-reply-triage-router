// Code node: "Format Error" (Run Once for All Items)
// Builds a Slack alert from the Error Trigger payload. Sandbox mode (default) only previews it.
let sandbox = true;
try { sandbox = loadConfig(readEnv($env)).sandbox; } catch (e) { /* invalid env: stay in sandbox */ }

const d = $input.first().json;
const ex = d.execution || {};
const err = ex.error || {};

return [{
  json: {
    sandbox,
    payload: buildErrorPayload({
      workflowName: (d.workflow && d.workflow.name) || 'unknown workflow',
      nodeName: ex.lastNodeExecuted || (err.node && err.node.name) || 'unknown node',
      message: err.message || 'Unknown error',
      executionId: ex.id,
      sandbox,
    }),
  },
}];
