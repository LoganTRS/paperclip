import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import {
  companies,
  createDb,
  projects as projectsTable,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { projectService } from "../services/projects.js";
import type { Db } from "@paperclipai/db";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping company default workspace policy inheritance tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

// A company-level default execution-workspace policy is inherited by new
// projects created WITHOUT an explicit executionWorkspacePolicy. An explicit
// per-project policy always wins; an empty object ({}) and null both count as
// "not supplied" and therefore inherit. The value is normalized through the
// same parser used at the project read boundary before it is persisted.
describeEmbeddedPostgres("company default project workspace policy", () => {
  let db!: Db;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let prefixCounter = 0;

  const wayfinderDefault = {
    enabled: true,
    defaultMode: "isolated_workspace",
    workspaceStrategy: {
      type: "git_worktree",
      runtimeProvisionCommand: "bash /paperclip/instances/default/data/wayfinder-seed/seed-tracker.sh",
    },
  };

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-company-default-ws-policy-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(projectsTable);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedCompany(
    name: string,
    defaultPolicy: Record<string, unknown> | null = null,
  ): Promise<string> {
    prefixCounter += 1;
    const [company] = await db
      .insert(companies)
      .values({
        name,
        issuePrefix: `DPW${prefixCounter}`,
        ...(defaultPolicy ? { defaultProjectWorkspacePolicy: defaultPolicy } : {}),
      })
      .returning();
    return company.id;
  }

  function svc() {
    return projectService(db);
  }
  // The service exposes the create path as `create`.
  async function createProject(companyId: string, data: { name: string; executionWorkspacePolicy?: Record<string, unknown> }) {
    return svc().create(companyId, data) as unknown as Promise<{ id: string }>;
  }

  async function readProjectPolicy(id: string) {
    const [row] = await db
      .select({ executionWorkspacePolicy: projectsTable.executionWorkspacePolicy })
      .from(projectsTable)
      .where(eq(projectsTable.id, id));
    return row?.executionWorkspacePolicy ?? null;
  }

  it("inherits the company default when the caller supplies no policy", async () => {
    const companyId = await seedCompany("Inherits Default", wayfinderDefault);
    const created = await createProject(companyId, { name: "Testing Game" });
    const persisted = await readProjectPolicy(created.id);
    expect(persisted).toMatchObject(wayfinderDefault);
    // The provision command (the seeder) must have landed.
    expect(persisted).toMatchObject({
      enabled: true,
      defaultMode: "isolated_workspace",
      workspaceStrategy: {
        type: "git_worktree",
        runtimeProvisionCommand: "bash /paperclip/instances/default/data/wayfinder-seed/seed-tracker.sh",
      },
    });
  });

  it("treats an empty-object policy as not supplied (inherits the default)", async () => {
    const companyId = await seedCompany("Empty Object Inherits", wayfinderDefault);
    const created = await createProject(companyId, {
      name: "Empty Policy",
      executionWorkspacePolicy: {},
    });
    const persisted = await readProjectPolicy(created.id);
    expect(persisted).toMatchObject(wayfinderDefault);
  });

  it("lets an explicit per-project policy win over the company default", async () => {
    const companyId = await seedCompany("Explicit Wins", wayfinderDefault);
    const explicit = {
      enabled: true,
      defaultMode: "shared_workspace",
      workspaceStrategy: { type: "project_primary" },
    };
    const created = await createProject(companyId, {
      name: "Explicit Policy",
      executionWorkspacePolicy: explicit,
    });
    const persisted = await readProjectPolicy(created.id);
    expect(persisted).toMatchObject(explicit);
    // The company default's seeder command must NOT have leaked in.
    expect((persisted as Record<string, unknown>).workspaceStrategy as Record<string, unknown>).not.toHaveProperty(
      "runtimeProvisionCommand",
    );
  });

  it("does not inject a policy when the company has no default", async () => {
    const companyId = await seedCompany("No Default", null);
    const created = await createProject(companyId, { name: "No Default Project" });
    const persisted = await readProjectPolicy(created.id);
    expect(persisted).toBeNull();
  });

  it("normalizes a malformed company default through the parser (keeps valid parts only)", async () => {
    // A default with an unknown strategy type still yields a valid policy:
    // the parser drops the bad strategy but keeps enabled/defaultMode.
    const badDefault = {
      enabled: true,
      defaultMode: "isolated_workspace",
      workspaceStrategy: { type: "not_a_real_type" },
    };
    const companyId = await seedCompany("Normalizes Default", badDefault);
    const created = await createProject(companyId, { name: "Normalizes" });
    const persisted = await readProjectPolicy(created.id) as Record<string, unknown> | null;
    expect(persisted).not.toBeNull();
    expect(persisted!.enabled).toBe(true);
    expect(persisted!.defaultMode).toBe("isolated_workspace");
    expect(persisted!.workspaceStrategy).toBeUndefined();
  });

  it("ignores an empty-object company default (treats as unset)", async () => {
    const companyId = await seedCompany("Empty Default", {});
    const created = await createProject(companyId, { name: "Empty Default Project" });
    const persisted = await readProjectPolicy(created.id);
    expect(persisted).toBeNull();
  });
});