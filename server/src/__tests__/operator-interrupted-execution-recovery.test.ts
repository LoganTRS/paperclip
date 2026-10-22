import { randomUUID } from "node:crypto";
import { and, eq, inArray, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { agents, companies, createDb, heartbeatRuns, issueRecoveryActions, issues } from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { getExecutionBlocker } from "../services/execution-blocker.js";
import { LEGACY_RECOVERY_CAUSE, settleOperatorInterruptedExecutionRecovery, terminalizeLegacyExecution } from "../services/legacy-execution-recovery.js";

const support = await getEmbeddedPostgresTestSupport();
(support.supported ? describe : describe.skip)("operator-interrupted legacy stop reconciliation", () => {
  let db: ReturnType<typeof createDb>;
  let temporary: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  beforeAll(async () => {
    temporary = await startEmbeddedPostgresTestDatabase("operator-interrupt-recovery-");
    db = createDb(temporary.connectionString);
  }, 30_000);
  afterAll(async () => {
    await temporary?.cleanup();
  });

  async function seed() {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const issueId = randomUUID();
    const runId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Interrupt", issuePrefix: companyId.slice(0, 8) });
    await db.insert(agents).values({ id: agentId, companyId, name: "Coder", status: "idle", adapterType: "openhands_local" });
    await db.insert(issues).values({
      id: issueId, companyId, title: "Interrupted task", status: "in_progress", assigneeAgentId: agentId,
    });
    await db.insert(heartbeatRuns).values({
      id: runId, companyId, agentId, status: "running", runtimeMode: "legacy",
      runtimeModeResolvedAt: new Date(), startedAt: new Date(),
      contextSnapshot: { issueId, taskKey: issueId },
    });
    const run = (await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId)))[0]!;
    return { companyId, agentId, issueId, runId, run };
  }

  /** The interrupted run exactly as the operator interrupt path leaves it:
   * expected cancellation, acknowledged execution cancellation, and the
   * queued-comment interrupt marker. */
  const interruptedReceipts = {
    resultJson: {
      cancellation: {
        reason: "Interrupted to send queued messages",
        source: "queued_message",
        expected: true,
        initiator: { id: "user-1", type: "user" },
        recordedAt: "2026-10-22T18:29:04.808Z",
      },
      executionCancellation: { state: "acknowledged", acknowledgedAt: "2026-10-22T18:29:04.911Z" },
      queuedCommentInterruptQueueId: "queue-1",
      operatorInterrupted: true,
    },
  };

  it("retires the reconciliation hold created by an operator-interrupted stop", async () => {
    const f = await seed();
    await db.update(heartbeatRuns).set({
      status: "cancelled", errorCode: "operator_interrupted", finishedAt: new Date(),
      resultJson: interruptedReceipts.resultJson,
    }).where(eq(heartbeatRuns.id, f.runId));
    const cancelled = (await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.runId)))[0]!;
    const terminated = await terminalizeLegacyExecution({
      db, run: cancelled, status: "cancelled",
    });
    expect(terminated).not.toBeNull();
    const [hold] = await db.select().from(issueRecoveryActions).where(and(
      eq(issueRecoveryActions.companyId, f.companyId),
      eq(issueRecoveryActions.sourceIssueId, f.issueId),
    ));
    expect(hold).toMatchObject({ cause: LEGACY_RECOVERY_CAUSE, status: "active" });
    expect(await getExecutionBlocker(db, f.companyId, f.issueId)).toMatchObject({ runId: f.runId });

    expect(await settleOperatorInterruptedExecutionRecovery(db, { run: cancelled, actorId: "user-1" })).toBe(true);
    expect(await getExecutionBlocker(db, f.companyId, f.issueId)).toBeNull();
    const [resolved] = await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.id, hold.id));
    expect(resolved).toMatchObject({
      status: "resolved",
      outcome: "interrupted_by_operator",
      evidence: expect.objectContaining({
        operatorInterruptRecovery: expect.objectContaining({ actorId: "user-1" }),
      }),
    });
    // Idempotent: a second settlement finds nothing to settle.
    expect(await settleOperatorInterruptedExecutionRecovery(db, { run: cancelled, actorId: "user-1" })).toBe(false);
  });

  it.each([
    ["missing queued-comment marker", (rj: Record<string, unknown>) => { delete rj.queuedCommentInterruptQueueId; }],
    ["unacknowledged execution cancellation", (rj: Record<string, unknown>) => { rj.executionCancellation = { state: "requested" }; }],
    ["unexpected cancellation", (rj: Record<string, unknown>) => { rj.cancellation = { source: "provider", expected: false, reason: "Provider cancelled execution", recordedAt: "2026-10-22T18:00:00.000Z" }; }],
    ["no cancellation receipt", (rj: Record<string, unknown>) => { delete rj.cancellation; }],
    ["workspace restore failure", (rj: Record<string, unknown>) => { rj.workspaceRestoreFailure = "restore_unsafe_archive"; }],
  ])("leaves the hold in place when the stop is not a verified operator interrupt: %s", async (_label, mutate) => {
    const f = await seed();
    const resultJson = JSON.parse(JSON.stringify(interruptedReceipts.resultJson));
    mutate(resultJson);
    await db.update(heartbeatRuns).set({
      status: "cancelled", errorCode: "operator_interrupted", finishedAt: new Date(),
      resultJson: resultJson,
    }).where(eq(heartbeatRuns.id, f.runId));
    const cancelled = (await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.runId)))[0]!;
    const terminated = await terminalizeLegacyExecution({
      db, run: cancelled, status: "cancelled",
    });
    expect(terminated).not.toBeNull();
    const [hold] = await db.select().from(issueRecoveryActions).where(and(
      eq(issueRecoveryActions.companyId, f.companyId),
      eq(issueRecoveryActions.sourceIssueId, f.issueId),
    ));
    expect(hold).toMatchObject({ cause: LEGACY_RECOVERY_CAUSE, status: "active" });
    // The unverified stop must not be settleable: the hold blocks execution.
    expect(await settleOperatorInterruptedExecutionRecovery(db, { run: cancelled, actorId: "user-1" })).toBe(false);
    expect(await getExecutionBlocker(db, f.companyId, f.issueId)).not.toBeNull();
  });

  it("does not touch a different run's reconciliation hold", async () => {
    const f = await seed();
    // A separate stop for a different run on the same issue keeps its hold.
    const otherRunId = randomUUID();
    await db.insert(heartbeatRuns).values({
      id: otherRunId, companyId: f.companyId, agentId: f.agentId, status: "running",
      runtimeMode: "legacy", runtimeModeResolvedAt: new Date(), startedAt: new Date(),
      contextSnapshot: { issueId: f.issueId, taskKey: f.issueId },
    });
    await db.update(heartbeatRuns).set({ status: "failed", errorCode: "provider_error", finishedAt: new Date() })
      .where(eq(heartbeatRuns.id, otherRunId));
    // The interrupted stop lands first and takes the source-scoped slot, as in
    // the incident. The later failure of the other run supersedes that slot
    // (identity change) and opens its own hold.
    await db.update(heartbeatRuns).set({
      status: "cancelled", errorCode: "operator_interrupted", finishedAt: new Date(),
      resultJson: interruptedReceipts.resultJson,
    }).where(eq(heartbeatRuns.id, f.runId));
    const cancelled = (await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.runId)))[0]!;
    await terminalizeLegacyExecution({ db, run: cancelled, status: "cancelled" });
    const other = (await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, otherRunId)))[0]!;
    await terminalizeLegacyExecution({ db, run: other, status: "failed" });
    const [otherHold] = await db.select().from(issueRecoveryActions).where(and(
      eq(issueRecoveryActions.companyId, f.companyId),
      eq(issueRecoveryActions.sourceIssueId, f.issueId),
      sql`${issueRecoveryActions.evidence}->>'runId' = ${otherRunId}`,
    ));
    expect(otherHold).toMatchObject({ cause: LEGACY_RECOVERY_CAUSE, status: "active" });
    // The operator interrupt receipt still settles exactly this run's hold,
    // which the supersede above resolved as a distinct incident: it is never
    // resolved as an operator interrupt.
    expect(await settleOperatorInterruptedExecutionRecovery(db, { run: cancelled, actorId: "user-1" })).toBe(false);
    const holds = await db.select().from(issueRecoveryActions).where(and(
      eq(issueRecoveryActions.companyId, f.companyId),
      eq(issueRecoveryActions.sourceIssueId, f.issueId),
      inArray(issueRecoveryActions.status, ["active", "escalated", "resolved"]),
    ));
    const forOther = holds.find((hold) => hold.evidence.runId === otherRunId);
    expect(forOther).toMatchObject({ status: "active", cause: LEGACY_RECOVERY_CAUSE });
    const forInterrupted = holds.find((hold) => hold.evidence.runId === f.runId);
    // The superseded hold stays resolved by the supersede (identity change),
    // not by the interrupt settlement: its outcome must not be an operator
    // interrupt.
    expect(forInterrupted?.outcome).not.toBe("interrupted_by_operator");
    expect(await getExecutionBlocker(db, f.companyId, f.issueId)).not.toBeNull();
  });
});
