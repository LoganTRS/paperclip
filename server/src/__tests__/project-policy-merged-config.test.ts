import { randomUUID } from "node:crypto";
import { EMBEDDED_POSTGRES_TEST_TIMEOUT_MS } from "@paperclipai/db";
import { agents, companies, createDb, executionWorkspaces, issues, projects, projectWorkspaces } from "@paperclipai/db";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  buildExecutionWorkspaceAdapterConfig,
  parseIssueExecutionWorkspaceSettings,
  parseProjectExecutionWorkspacePolicy,
  resolveExecutionWorkspaceMode,
} from "../services/execution-workspace-policy.js";
import { issueService } from "../services/issues.js";
import { instanceSettingsService } from "../services/instance-settings.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import type { Db } from "@paperclipai/db";

const support = await getEmbeddedPostgresTestSupport();
(support.supported ? describe : describe.skip)("project policy flow into the run's merged workspace config", () => {
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: Db;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-project-policy-merge-");
    db = createDb(tempDb.connectionString);
  }, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS);

  afterAll(async () => {
    await db?.$client.end();
    await tempDb?.cleanup();
  });

  const wayfinderPolicy = {
    enabled: true,
    defaultMode: "isolated_workspace",
    workspaceStrategy: {
      type: "git_worktree",
      runtimeProvisionCommand: "bash /paperclip/instances/default/data/wayfinder-seed/seed-tracker.sh",
    },
  };

  /**
   * End-to-end contract for the fault chain (run a72dc3fb, issue fac781aa):
   *
   * 1. The project row stores a git_worktree execution_workspace_policy (with a
   *    runtimeProvisionCommand seeder).
   * 2. The issue was created earlier and carries a stale
   *    execution_workspace_settings = { mode: "shared_workspace" } plus a
   *    binding to a pre-existing shared_workspace/project_primary execution
   *    workspace (execution_workspace_preference = "reuse_existing").
   * 3. The run must still resolve the project's git_worktree strategy and the
   *    provision command must be present in the merged config — otherwise
   *    workspace-preparation realizes the workspace as
   *    shared_workspace/project_primary/copy and the seeder never runs.
   *
   * The mergedConfig assembly is `execution-configuration.ts:79-84`:
   *   mergedConfig = { ...sourceWorkspaceConfig }
   * where sourceWorkspaceConfig = buildExecutionWorkspaceAdapterConfig(...).
   */
  async function fixture() {
    const companyId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Policy flow", issuePrefix: `PF${companyId.slice(0, 6)}` });
    const [agent] = await db.insert(agents).values({ companyId, name: "Wayfinder", status: "idle", adapterType: "hermes_local" }).returning();
    const [project] = await db.insert(projects).values({ companyId, name: "Testing Game", executionWorkspacePolicy: wayfinderPolicy }).returning();
    const source = `/tmp/pf-source-${project.id}`;
    const [projectWorkspace] = await db.insert(projectWorkspaces).values({ companyId, projectId: project.id, name: "Source", cwd: source, isPrimary: true }).returning();
    // Pre-existing shared workspace the issue is bound to (reused across runs).
    const [sharedWorkspace] = await db.insert(executionWorkspaces).values({
      companyId, projectId: project.id, projectWorkspaceId: projectWorkspace.id,
      name: "Shared files", cwd: source, mode: "shared_workspace", strategyType: "project_primary",
    }).returning();
    // Stale pin: at create time the project's defaultMode was shared_workspace,
    // so the issue row persisted mode-only settings and the reuse_existing binding.
    const [issue] = await db.insert(issues).values({
      companyId, title: "Map the 2d golfing game", identifier: "PF-1", projectId: project.id,
      projectWorkspaceId: projectWorkspace.id, assigneeAgentId: agent.id,
      executionWorkspaceId: sharedWorkspace.id,
      executionWorkspacePreference: "reuse_existing",
      executionWorkspaceSettings: { mode: "shared_workspace" },
    }).returning();
    return { companyId, project, issue, sharedWorkspace };
  }

  it("carries the project git_worktree policy into the run's mergedConfig despite a stale shared_workspace issue pin", async () => {
    const { project, issue } = await fixture();
    const settings = instanceSettingsService(db);
    const previousExperimental = await settings.getExperimental();
    // The live instance runs with isolated workspaces enabled; the embedded
    // test DB needs the same experimental flag for policy gating.
    await settings.updateExperimental({ ...previousExperimental, enableIsolatedWorkspaces: true });
    try {
      const isolatedWorkspacesEnabled = (await settings.getExperimental()).enableIsolatedWorkspaces;
      expect(isolatedWorkspacesEnabled).toBe(true);

    const projectPolicy = parseProjectExecutionWorkspacePolicy(project.executionWorkspacePolicy);
    const issueSettings = parseIssueExecutionWorkspaceSettings(issue.executionWorkspaceSettings);
    expect(projectPolicy).toMatchObject({ enabled: true, defaultMode: "isolated_workspace" });
    expect(projectPolicy?.workspaceStrategy).toMatchObject({
      type: "git_worktree",
      runtimeProvisionCommand: "bash /paperclip/instances/default/data/wayfinder-seed/seed-tracker.sh",
    });
    // The stale pin: the issue row says shared_workspace (no strategy of its own).
    expect(issueSettings?.mode).toBe("shared_workspace");
    expect(issueSettings?.workspaceStrategy).toBeUndefined();

    // Mode resolution exactly as heartbeat.ts:2540 does it.
    const requestedExecutionWorkspaceMode = resolveExecutionWorkspaceMode({
      projectPolicy,
      issueSettings,
      legacyUseProjectWorkspace: null,
    });
    // The project's enabled isolated_workspace default must win over the stale pin.
    expect(requestedExecutionWorkspaceMode).toBe("isolated_workspace");

    // The run's mergedConfig is built from sourceWorkspaceConfig
    // (execution-configuration.ts:79-84, useIsolatedTaskDirectory=false here).
    const sourceWorkspaceConfig = buildExecutionWorkspaceAdapterConfig({
      agentConfig: {},
      projectPolicy,
      issueSettings,
      mode: requestedExecutionWorkspaceMode,
      legacyUseProjectWorkspace: null,
    });
    const mergedConfig = { ...sourceWorkspaceConfig };

    // The run must carry the project's git_worktree strategy and the seeder.
    expect(mergedConfig.workspaceStrategy).toMatchObject({
      type: "git_worktree",
      runtimeProvisionCommand: "bash /paperclip/instances/default/data/wayfinder-seed/seed-tracker.sh",
    });
    } finally {
      await settings.updateExperimental(previousExperimental);
    }
  });

  it("reuses the project policy's default mode when the issue row carries no pin at all", async () => {
    const settings = instanceSettingsService(db);
    const previousExperimental = await settings.getExperimental();
    await settings.updateExperimental({ ...previousExperimental, enableIsolatedWorkspaces: true });
    try {
      const companyId = randomUUID();
      await db.insert(companies).values({ id: companyId, name: "No pin", issuePrefix: `NP${companyId.slice(0, 6)}` });
      const [agent] = await db.insert(agents).values({ companyId, name: "Wayfinder", status: "idle", adapterType: "hermes_local" }).returning();
      const [project] = await db.insert(projects).values({ companyId, name: "Testing Game", executionWorkspacePolicy: wayfinderPolicy }).returning();
      const created = await issueService(db).create(companyId, {
        title: "Create without settings",
        projectId: project.id,
        assigneeAgentId: agent.id,
      });
      const [row] = await db.select({ executionWorkspaceSettings: issues.executionWorkspaceSettings }).from(issues).where(eq(issues.id, created.id));
      // A create must persist the project's default mode (isolated_workspace), not shared_workspace.
      expect(row.executionWorkspaceSettings).toMatchObject({ mode: "isolated_workspace" });
    } finally {
      await settings.updateExperimental(previousExperimental);
    }
  });

  afterEach(async () => {
    await db.delete(issues);
    await db.delete(executionWorkspaces);
    await db.delete(projectWorkspaces);
    await db.delete(projects);
    await db.delete(agents);
    await db.delete(companies);
  });
});
