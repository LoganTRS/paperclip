#!/usr/bin/env node
/**
 * paperclip-label-router.mjs
 *
 * GitHub-side half of the label → agent routing design.
 *
 * Paperclip's native wake reasons include `issue_assigned` (issues.ts:12658)
 * but NOT a label reason. So the GitHub label drives the *assignment*: this
 * script reads the GitHub issue's labels, looks up the target Paperclip agent
 * in a per-repo routing file, creates/links the Paperclip issue (idempotent),
 * and assigns it to that agent. Paperclip then natively wakes the assigned
 * agent — no Paperclip core change, no plugin, no public HTTPS webhook.
 *
 * Run from a GitHub Actions workflow on `issues.opened` / `issues.labeled` /
 * `issue_commented`, or locally for testing:
 *
 *   PAPERCLIP_URL=http://10.69.95.194:3100 \
 *   PAPERCLIP_API_KEY=*** \
 *   PAPERCLIP_ROUTING_FILE=.paperclip-routing.json \
 *   GH_OWNER=owner GH_REPO=repo GH_NUMBER=123 GH_LABELS=code,triage \
 *   node scripts/paperclip-label-router.mjs
 *
 * Per-repo routing file (`.paperclip-routing.json`), one entry per routed label:
 *   {
 *     "companyId": "<paperclip company id>",
 *     "routes": { "code": "<openhands agent id>", "wayfinder": "<hermes agent id>" }
 *   }
 */

const fs = await import("node:fs");

function env(name, fallback = "") {
  return process.env[name] ?? fallback;
}
function fail(msg) {
  console.error(`[paperclip-label-router] ${msg}`);
  process.exit(1);
}

const url = env("PAPERCLIP_URL", "http://10.69.95.194:3100").replace(/\/+$/, "");
const apiKey = env("PAPERCLIP_API_KEY");
const routingFile = env("PAPERCLIP_ROUTING_FILE", ".paperclip-routing.json");
const owner = env("GH_OWNER");
const repo = env("GH_REPO");
const number = env("GH_NUMBER");
const labels = (env("GH_LABELS") || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

if (!apiKey) fail("PAPERCLIP_API_KEY is required");
if (!owner || !repo || !number) {
  fail("GH_OWNER, GH_REPO, and GH_NUMBER are required");
}

// Load the per-repo routing file.
let routing;
try {
  routing = JSON.parse(fs.readFileSync(routingFile, "utf8"));
} catch (err) {
  fail(`could not read routing file ${routingFile}: ${err.message}`);
}
const companyId = routing.companyId;
const routes = routing.routes || {};
if (!companyId) fail(`routing file missing companyId (${routingFile})`);

// Find the first GitHub label that has a mapped agent.
const labelToAgentId = Object.entries(routes).find(([label]) => labels.includes(label));
if (!labelToAgentId) {
  console.log(
    `[paperclip-label-router] no routed label found in [${labels.join(", ")}] (routes: ${Object.keys(
      routes
    ).join(", ")}); nothing to do`,
  );
  process.exit(0);
}
const [matchedLabel, agentId] = labelToAgentId;

// Idempotent key ties the Paperclip issue to the GitHub issue.
const idempotencyKey = `gh:${owner}/${repo}#${number}`;

const body = {
  title: `[${owner}/${repo}#${number}] (label: ${matchedLabel})`,
  description: `Routed from GitHub issue ${owner}/${repo}#${number} via label \`${matchedLabel}\`.`,
  idempotencyKey,
  assigneeAgentId: agentId, // assign on create → native issue_assigned wake
};

async function call(method, path, payload) {
  const res = await fetch(`${url}${path}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: payload ? JSON.stringify(payload) : undefined,
  });
  const text = await res.text();
  let data = null;
  try {
    data = JSON.parse(text);
  } catch {
    /* non-JSON */
  }
  if (!res.ok) {
    fail(
      `${method} ${path} → ${res.status}: ${
        data && data.error ? data.error : text.slice(0, 300)
      }`,
    );
  }
  return data;
}

const created = await call(
  "POST",
  `/api/companies/${companyId}/issues`,
  body,
);
const issue = created.issue || created;
console.log(
  `[paperclip-label-router] label \`${matchedLabel}\` → assigned to agent ${agentId} ` +
    `(issue ${issue.id}, idempotencyKey ${idempotencyKey})`,
);
