#!/usr/bin/env node
/**
 * paperclip-wayfinder-project.mjs
 *
 * Board-side helper that creates a Paperclip project for a GitHub repo with the
 * wayfinder tracker fully wired in ONE shot, so "attach a GitHub repo" = ready:
 *
 *   1. Seeds `docs/agents/issue-tracker.md` into every task worktree via the
 *      project's executionWorkspacePolicy.workspaceStrategy.provisionCommand
 *      (runs automatically at workspace prep — no per-task, no per-repo seed).
 *   2. Injects `GITHUB_TOKEN` into the project's run env so the wayfinder agent
 *      can `gh issue create` the `code` tickets (OpenHands auto-spawn).
 *
 * It talks to the Paperclip REST API with a board agent key. It never prints
 * the token value.
 *
 * Two modes:
 *
 *   # A. Store the GitHub PAT as a company secret (do this once, or when you
 *   #    rotate the token). Prints the secretId to use in mode B.
 *   PAPERCLIP_URL=http://10.69.95.194:3100 \
 *   PAPERCLIP_API_KEY=*** \
 *   PAPERCLIP_COMPANY_ID=<companyId> \
 *   GITHUB_TOKEN=*** \
 *   node scripts/paperclip-wayfinder-project.mjs create-secret --name github_pat
 *
 *   # B. Create the project for a GitHub repo, wired (provision command + token).
 *   PAPERCLIP_URL=http://10.69.95.194:3100 \
 *   PAPERCLIP_API_KEY=*** \
 *   PAPERCLIP_COMPANY_ID=<companyId> \
 *   node scripts/paperclip-wayfinder-project.mjs create \
 *     --name "My Project" \
 *     --repo owner/name \
 *     --github-secret-id <secretId-from-A>      # or
 *     --github-token-env GITHUB_TOKEN=***        # (plain, avoids a secret)
 *
 * `--repo owner/name` is resolved to the connected repo's id via
 * GET /api/companies/:cid/project-repositories. If no connected repo matches,
 * it falls back to `repositoryUrls` (the repo must be reachable by the API).
 *
 * Env vars (all required for `create` unless a flag substitutes):
 *   PAPERCLIP_URL        Paperclip base URL (with or without /api)
 *   PAPERCLIP_API_KEY    Board agent API key (Authorization: Bearer)
 *   PAPERCLIP_COMPANY_ID company id
 *   WAYFINDER_SEED_DIR   optional; override the seed dir used in the provision
 *                        command (defaults to $PAPERCLIP_HOME/instances/<id>/data/wayfinder-seed
 *                        evaluated at run time inside the container)
 */

const fs = await import("node:fs");

function env(name, fallback = "") {
  return process.env[name] ?? fallback;
}
function fail(msg) {
  console.error(`[wayfinder-project] ${msg}`);
  process.exit(1);
}

// ── Args ──────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const mode = argv[0] || "create";
function flag(name) {
  const i = argv.indexOf(name);
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : undefined;
}
function hasFlag(name) {
  return argv.includes(name);
}

const url = env("PAPERCLIP_URL", "http://127.0.0.1:3100").replace(/\/+$/, "");
let api = url;
if (!/\/api$/.test(api)) api = `${api}/api`;
const apiKey = env("PAPERCLIP_API_KEY");
const companyId = env("PAPERCLIP_COMPANY_ID") || flag("--company-id");
const needsApi = mode === "create" || mode === "create-secret";
if (needsApi) {
  if (!apiKey) fail("PAPERCLIP_API_KEY is required");
  if (!companyId) fail("PAPERCLIP_COMPANY_ID (or --company-id) is required");
}

async function http(method, path, body) {
  const res = await fetch(`${api}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${apiKey}`,
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }
  if (!res.ok) {
    // Never echo the token; summarize the error.
    const detail = json ? JSON.stringify(json).slice(0, 400) : text.slice(0, 400);
    fail(`API ${method} ${path} -> ${res.status}: ${detail}`);
  }
  return json;
}

// ── The provision command (self-contained; finds the seed via PAPERCLIP_HOME) ─
// Built with plain string concat (NOT a template literal) so the bash ${...}
// expansions are not treated as JS interpolation.
function provisionCommand() {
  const seedOverride = env("WAYFINDER_SEED_DIR");
  const seedExpr = seedOverride
    ? `sd=${JSON.stringify(seedOverride)}`
    : 'sd="${PAPERCLIP_HOME:-/paperclip}/instances/${PAPERCLIP_INSTANCE_ID:-default}/data/wayfinder-seed"';
  const body =
    'wt="${PAPERCLIP_WORKSPACE_CWD:-$PWD}"; ' +
    'if [ -f "$sd/seed-tracker.sh" ]; then bash "$sd/seed-tracker.sh"; ' +
    'elif [ -f "$sd/issue-tracker.md" ]; then mkdir -p "$wt/docs/agents" && ' +
    '{ [ -f "$wt/docs/agents/issue-tracker.md" ] || cp "$sd/issue-tracker.md" "$wt/docs/agents/issue-tracker.md"; }; fi; ' +
    'exit 0';
  return "bash -lc '" + seedExpr + "; " + body + "'";
}

// ── Mode A: create the GitHub secret ──────────────────────────────────────
async function createSecret() {
  const name = flag("--name") || "github_pat";
  const value = env("GITHUB_TOKEN") || flag("--token");
  if (!value) fail("GITHUB_TOKEN env (or --token) is required for create-secret");
  const created = await http(
    "POST",
    `/companies/${companyId}/secrets`,
    {
      name,
      value,
      provider: "local_encrypted",
      description: "GitHub PAT for wayfinder code tickets (repo scope).",
    },
  );
  if (!created?.id) fail("create-secret did not return an id");
  console.error(`[wayfinder-project] stored secret "${name}" id=${created.id}`);
  // Print ONLY the id (never the value) for the operator to use in mode B.
  console.log(JSON.stringify({ secretId: created.id, name: created.name }));
}

// ── Mode B: create the wired project ──────────────────────────────────────
async function create() {
  const name = flag("--name") || flag("--project");
  if (!name) fail("--name is required for create");
  const repo = flag("--repo");
  if (!repo) fail("--repo owner/name (or --repo-url) is required for create");

  // Build the GITHUB_TOKEN env binding.
  const envBindings = {};
  const secretId = flag("--github-secret-id");
  const tokenEnv = flag("--github-token-env"); // e.g. "GITHUB_TOKEN" or "GITHUB_TOKEN=<val>"
  if (secretId) {
    envBindings.GITHUB_TOKEN = { type: "secret_ref", secretId };
  } else if (tokenEnv) {
    if (tokenEnv.includes("=")) {
      const [k, ...rest] = tokenEnv.split("=");
      envBindings[k] = { type: "plain", value: rest.join("=") };
    } else {
      // Reference an already-exported env var name as a plain binding is not
      // possible server-side; require the value inline.
      const v = env(tokenEnv);
      if (!v) fail(`--github-token-env ${tokenEnv}: env var ${tokenEnv} is empty. Pass GITHUB_TOKEN=*** inline or use --github-secret-id.`);
      envBindings[tokenEnv] = { type: "plain", value: v };
    }
  } else if (env("GITHUB_TOKEN")) {
    envBindings.GITHUB_TOKEN = { type: "plain", value: env("GITHUB_TOKEN") };
  }
  // No token binding is allowed: the project still works for wayfinding +
  // question cards; only the `code`-ticket GitHub writes would lack a token.

  // Resolve the repo to a connected id, else use repositoryUrls.
  let body = {
    name,
    executionWorkspacePolicy: {
      enabled: true,
      defaultMode: "shared_workspace",
      workspaceStrategy: {
        type: "git_worktree",
        provisionCommand: provisionCommand(),
      },
    },
  };
  if (Object.keys(envBindings).length > 0) body.env = envBindings;

  let usedUrls = false;
  if (!flag("--repo-url")) {
    const repos = await http("GET", `/companies/${companyId}/project-repositories`);
    const list = Array.isArray(repos) ? repos : repos?.repositories ?? repos?.items ?? [];
    const norm = (s) => s.replace(/\.git$/, "").replace(/\/+$/, "").toLowerCase();
    const want = norm(repo);
    const match = list.find((r) => norm(r.fullName || r.name || "") === want || norm(r.url || "") === `github.com/${want}`);
    if (match?.id) {
      body.repositoryIds = [String(match.id)];
    } else {
      // Fall back to the URL form (API must be able to reach it).
      body.repositoryUrls = [`https://github.com/${repo.replace(/^github\.com\//, "")}`];
      usedUrls = true;
      console.error(`[wayfinder-project] no connected repo matched "${repo}"; using repositoryUrls fallback.`);
    }
  } else {
    body.repositoryUrls = [flag("--repo-url")];
    usedUrls = true;
  }

  const created = await http("POST", `/companies/${companyId}/projects`, body);
  if (!created?.id) fail("project create did not return an id");

  console.error(`[wayfinder-project] created project "${created.name}" id=${created.id}`);
  console.error(`[wayfinder-project] provision command: ${body.executionWorkspacePolicy.workspaceStrategy.provisionCommand}`);
  console.error(`[wayfinder-project] GITHUB_TOKEN binding: ${Object.keys(envBindings).length ? Object.keys(envBindings).join(", ") : "(none — set a token for code tickets)"}`);
  console.error(`[wayfinder-project] repo wiring: ${body.repositoryIds ? `repositoryIds=[${body.repositoryIds}]` : `repositoryUrls=[${body.repositoryUrls}]`}`);
  console.log(JSON.stringify({
    projectId: created.id,
    name: created.name,
    provisionCommand: body.executionWorkspacePolicy.workspaceStrategy.provisionCommand,
    githubTokenKeys: Object.keys(envBindings),
    repositoryIds: body.repositoryIds ?? null,
    repositoryUrls: body.repositoryUrls ?? null,
  }));
}

// ── Mode C: print the provision command (dry, no network) ─────────────────
function printCmd() {
  const cmd = provisionCommand();
  console.error(`[wayfinder-project] seed dir override: ${env("WAYFINDER_SEED_DIR") || "(auto, via PAPERCLIP_HOME at run time)"}`);
  console.log(JSON.stringify({ provisionCommand: cmd }));
}

if (mode === "create-secret") await createSecret();
else if (mode === "create") await create();
else if (mode === "print-cmd") await printCmd();
else fail(`unknown mode "${mode}" (use "create", "create-secret", or "print-cmd")`);
