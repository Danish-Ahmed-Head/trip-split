// Trip Split: free 5-minute timer for the alert job.
//
// GitHub's own scheduler runs the job hours late on a quiet repo, so this tiny
// Cloudflare Worker (free plan: cron triggers, 100k requests/day) asks GitHub to
// run .github/workflows/push.yml every 5 minutes instead. It holds no Firebase
// key and reads no data; it can only start that one workflow.
//
// Setup (see README "Closed-app alerts"):
//   1. Worker secret GH_TOKEN = a fine-grained GitHub token limited to the
//      trip-split repo with "Actions: Read and write" and nothing else.
//   2. Cron trigger: */5 * * * *

const WORKFLOW = "https://api.github.com/repos/Danish-Ahmed-Head/trip-split/actions/workflows/push.yml/dispatches";

async function dispatch(env) {
  if (!env.GH_TOKEN) {
    console.log("GH_TOKEN is not set; nothing to do");
    return;
  }
  const res = await fetch(WORKFLOW, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.GH_TOKEN}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "trip-split-alert-timer",
    },
    body: JSON.stringify({ ref: "main" }),
  });
  // 204 = started. Log anything else so it shows in the Worker's logs.
  if (res.status !== 204) console.log("dispatch failed", res.status, (await res.text()).slice(0, 300));
}

export default {
  async scheduled(event, env, ctx) {
    ctx.waitUntil(dispatch(env));
  },
  // The Worker's public URL does nothing.
  async fetch() {
    return new Response("Not found", { status: 404 });
  },
};
