import { AsyncLocalStorage } from "node:async_hooks";
import { withDedicatedDbConnection, type Db } from "@paperclipai/db";
import { sql } from "drizzle-orm";
import path from "node:path";
import fs from "node:fs/promises";
import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";
import type { TaskWorkspaceIntent } from "@paperclipai/shared";
import { isGitHubHttpsRemoteUrl, type GitRemoteAuthProvider } from "./git-credentials.js";
import { resolvePaperclipInstanceRoot } from "../home-paths.js";
import { materializeManagedProjectWorkspace } from "./managed-repository-checkout.js";
import { measureRunPhase } from "./execution-preparation-timing.js";
import { isRestrictedWorkspaceSourceDenial } from "./workspace-source-restriction.js";

const execFile = promisify(execFileCallback);

const sourceLocks = new AsyncLocalStorage<ReadonlyArray<{ db: Db; key: string }>>();
export class IsolatedRepositorySourceBusy extends Error {}

/** Creation, reopening and base expiration share this cross-process exclusion. */
export async function withIsolatedRepositorySourceLock<T>(db: Db, companyId: string, issueId: string,
  action: () => Promise<T>, tryOnly = false): Promise<T> {
  const key = `isolated_repository_source:${companyId}:${issueId}`;
  const held = sourceLocks.getStore() ?? [];
  if (held.some(lock => lock.db === db && lock.key === key)) return action();
  return withDedicatedDbConnection(db, connection => connection.transaction(async tx => {
    if (tryOnly) {
      const rows = await tx.execute<{ acquired: boolean }>(sql`select pg_try_advisory_xact_lock(hashtextextended(${key}, 0)) as acquired`);
      if (!rows[0]?.acquired) throw new IsolatedRepositorySourceBusy();
    } else await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${key}, 0))`);
    return sourceLocks.run([...held, { db, key }], action);
  }));
}


export function isolatedRemoteSourcePath(companyId: string, issueId: string): string {
  if ([companyId, issueId].some(id => !/^[a-zA-Z0-9_-]+$/.test(id))) {
    throw new Error("Invalid isolated repository source identity");
  }
  return path.join(resolvePaperclipInstanceRoot(), "isolated-repository-sources", companyId, issueId, "checkout");
}

export function recordedIsolatedRemoteSource(input: {
  companyId?: string;
  sourceIssueId: string | null;
  repoUrl: string | null;
  metadata?: Record<string, unknown> | null;
}): string | null {
  const value = input.metadata?.isolatedRemoteSource;
  if (value === undefined) return null;
  const source = value as Record<string, unknown> | null;
  if (!source || source.schema !== "paperclip.isolated-remote-source.v1"
    || !input.companyId || !input.sourceIssueId || source.companyId !== input.companyId
    || source.issueId !== input.sourceIssueId || source.repoUrl !== input.repoUrl) {
    throw new Error("Recorded isolated repository source identity changed");
  }
  return isolatedRemoteSourcePath(input.companyId, input.sourceIssueId);
}

/** Strip userinfo (`https://user:pass@host/...` -> `https://host/...`) from a remote
 * URL so identity checks compare the repository (host + path), not the credential.
 *
 * The Coder agent authenticates git operations via an inline `x-access-token` userinfo
 * (it has `GITHUB_TOKEN` in its run env and uses `git` directly), and a push/fetch with an
 * inline-cred URL can leave that userinfo persisted in the worktree's `remote.origin.url`.
 * That is legitimate — the host + path still name the same repository — but a byte-for-byte
 * comparison against the bare `repoUrl` then fails with "Isolated repository source identity
 * changed" and the next continuation run dies in `preparing` (setup_failed), which strands
 * the issue in a blocked/recovery limbo. Canonicalizing the userinfo before comparing keeps
 * the security property (a *different* host or path is still rejected) while tolerating the
 * credential the agent itself added.
 */
export function canonicalRemoteUrlForIdentity(rawUrl: string): string {
  // `git config --get-all` with `--null` returns `<url>\0`; callers strip the NUL before
  // calling here, but be defensive.
  const url = rawUrl.replace(/\0+$/u, "");
  if (!url) return url;
  // Strip a userinfo component (`https://user:pass@host/...` -> `https://host/...`) so the
  // identity check compares the repository (host + path), not the credential the agent
  // persisted. Only touch http(s)/ssh URLs; leave scp-style and file paths alone.
  const match = url.match(/^(https?:|ssh:)\/\/([^@/]*@)?(.*)$/);
  if (!match) return url;
  const [full, proto, , rest] = match;
  void full;
  // Normalize a single trailing slash so `repo` and `repo/` compare equal.
  const normalized = rest.length > 1 ? rest.replace(/\/+$/u, "") : rest;
  return `${proto}//${normalized}`;
}

async function assertRemoteSourceIdentity(cwd: string, repoUrl: string) {
  const root = resolvePaperclipInstanceRoot();
  const canonicalCwd = await fs.realpath(cwd);
  if (canonicalCwd !== path.join(await fs.realpath(root), path.relative(root, cwd))) {
    throw new Error("Isolated repository source path changed");
  }
  const gitDir = path.join(canonicalCwd, ".git");
  const entry = await fs.lstat(gitDir);
  if (!entry.isDirectory() || entry.isSymbolicLink()) throw new Error("Isolated repository source Git storage changed");
  const options = { timeout: 10_000, maxBuffer: 16 * 1024 };
  const common = await execFile("git", ["-C", canonicalCwd, "rev-parse", "--path-format=absolute", "--git-common-dir"], options);
  if (common.stdout.trim() !== gitDir) throw new Error("Isolated repository source Git storage changed");
  const origin = await execFile("git", ["-C", canonicalCwd, "config", "--local", "--null", "--get-all", "remote.origin.url"], options);
  // Compare the canonicalized (userinfo-stripped) origin URL against the canonicalized
  // expected repoUrl. The agent may have persisted an inline credential into the origin
  // URL (see canonicalRemoteUrlForIdentity); the host + path must still match.
  if (origin.stdout === "\0") return; // no origin configured — nothing to verify
  const [actualOrigin] = origin.stdout.split("\0").filter(Boolean);
  if (canonicalRemoteUrlForIdentity(actualOrigin) !== canonicalRemoteUrlForIdentity(repoUrl)) {
    throw new Error("Isolated repository source identity changed");
  }
}

export async function verifiedRecordedIsolatedRemoteSource(input: Parameters<typeof recordedIsolatedRemoteSource>[0]): Promise<string | null> {
  const cwd = recordedIsolatedRemoteSource(input);
  if (cwd) await assertRemoteSourceIdentity(cwd, input.repoUrl!);
  return cwd;
}

export function canIsolateRemoteWorkspaceSource(input: {
  error: unknown;
  repoUrl: string | null;
  reuseExisting: boolean;
  hasExistingWorkspace: boolean;
  selectedProjectWorkspaceId: string | null;
  selection: TaskWorkspaceIntent | null | undefined;
  strategy: Record<string, unknown>;
  trustPresetKind: string;
}): boolean {
  const branchTemplate = input.strategy.branchTemplate;
  const selectsFixedBranch = typeof branchTemplate === "string" && branchTemplate.length > 0
    && !/\{\{\s*(?:issue\.(?:id|identifier|title)|slug)\s*\}\}/.test(branchTemplate);
  if (input.trustPresetKind !== "standard" || !isRestrictedWorkspaceSourceDenial(input.error)
    || input.reuseExisting || input.hasExistingWorkspace || input.strategy.existingBranch || selectsFixedBranch
    || (input.selection && !["project", "task_default"].includes(input.selection.source))
    || (input.selectedProjectWorkspaceId && (input.selection?.selection.kind !== "configured_source"
      || input.selection.selection.projectWorkspaceId !== input.selectedProjectWorkspaceId))) return false;
  if (!input.repoUrl) return false;
  try {
    const url = new URL(input.repoUrl);
    return ["https:", "ssh:"].includes(url.protocol) && !!url.hostname && !url.password
      && (url.protocol === "ssh:" || !url.username);
  } catch { return false; }
}

export async function materializeIsolatedRemoteWorkspaceSource(input: {
  companyId: string;
  issueId: string;
  repoUrl: string;
  resolveGitAuth: GitRemoteAuthProvider;
}): Promise<string> {
  const cwd = isolatedRemoteSourcePath(input.companyId, input.issueId);
  const canonicalCwd = await measureRunPhase("workspace.materialize.directories", async () => {
    const root = resolvePaperclipInstanceRoot();
    await fs.mkdir(root, { recursive: true });
    const canonicalRoot = await fs.realpath(root);
    let parent = canonicalRoot;
    for (const segment of ["isolated-repository-sources", input.companyId, input.issueId]) {
      parent = path.join(parent, segment);
      await fs.mkdir(parent, { mode: 0o700 }).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== "EEXIST") throw error;
      });
      const entry = await fs.lstat(parent);
      if (!entry.isDirectory() || entry.isSymbolicLink() || await fs.realpath(parent) !== parent) {
        throw new Error("Isolated repository source path is not a private directory");
      }
    }
    const checkout = path.join(parent, "checkout");
    const entry = await fs.lstat(checkout).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return null;
      throw error;
    });
    if (entry && (!entry.isDirectory() || entry.isSymbolicLink())) {
      throw new Error("Isolated repository source cannot be a symbolic link");
    }
    return checkout;
  });
  const result = await materializeManagedProjectWorkspace(canonicalCwd, {
    repoUrl: input.repoUrl, resolveGitAuth: input.resolveGitAuth,
    objectCacheCompanyDirectory: isGitHubHttpsRemoteUrl(input.repoUrl)
      ? path.join(await fs.realpath(resolvePaperclipInstanceRoot()), "repository-object-cache", input.companyId) : undefined,
  });
  if (result.warning) throw new Error("Isolated repository source is not a Git checkout");
  await measureRunPhase("workspace.materialize.source_identity", () => assertRemoteSourceIdentity(cwd, input.repoUrl));
  return cwd;
}
