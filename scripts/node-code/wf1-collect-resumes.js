// Code node: "Collect Due Resumes" (Run Once for All Items)
// Daily: out-of-office contacts whose return date has passed become resume actions
// (resume webhook, or a re-enroll reminder task / Slack message). Sandbox runs never modify the queue.
const env = readEnv($env);
const cfg = loadConfig(env);
const state = $getWorkflowStaticData('global');
const queue = Array.isArray(state.resumeQueue) ? state.resumeQueue : [];
const nowMs = Date.now();
const due = queue.filter((i) => Date.parse(i.resumeAt) <= nowMs);
if (!due.length) return [];

const out = [];
due.forEach((item) => {
  planResume(item, cfg, nowMs).forEach((action) => {
    out.push({ json: { sandbox: cfg.sandbox, replyId: item.key, outputIndex: action.outputIndex, action } });
  });
});
if (!cfg.sandbox) state.resumeQueue = queue.filter((i) => !due.includes(i));

return out;
