import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  agents,
  companies,
  createDb,
  heartbeatRuns,
  issueReports,
  issues,
} from "@paperclipai/db";
import { buildPaperclipWakePayload } from "../services/heartbeat.ts";
import { issueReportService } from "../services/issue-reports.ts";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.ts";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

describeEmbeddedPostgres("issue reports", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    const started = await startEmbeddedPostgresTestDatabase("paperclip-issue-reports-");
    db = createDb(started.connectionString);
    tempDb = started;
  }, 120_000);

  afterAll(async () => {
    await db?.$client?.end?.({ timeout: 0 });
    await tempDb?.cleanup();
  });

  it("deduplicates fingerprints and consumes pending reports in the target heartbeat", async () => {
    const companyId = randomUUID();
    const originAgentId = randomUUID();
    const targetAgentId = randomUUID();
    const originIssueId = randomUUID();
    const targetIssueId = randomUUID();
    const originRunId = randomUUID();
    const targetRunId = randomUUID();
    const issuePrefix = `R${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;

    await db.insert(companies).values({
      id: companyId,
      name: "Report Test Company",
      issuePrefix,
      requireBoardApprovalForNewAgents: false,
      defaultResponsibleUserId: "responsible-user",
    });
    await db.insert(agents).values([
      {
        id: originAgentId,
        companyId,
        name: "Origin Agent",
        role: "engineer",
        status: "idle",
        adapterType: "process",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
      {
        id: targetAgentId,
        companyId,
        name: "Target Agent",
        role: "engineer",
        status: "idle",
        adapterType: "process",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
    ]);
    await db.insert(issues).values([
      {
        id: originIssueId,
        companyId,
        title: "Origin issue",
        status: "in_progress",
        priority: "medium",
        responsibleUserId: "responsible-user",
        assigneeAgentId: originAgentId,
        issueNumber: 1,
        identifier: `${issuePrefix}-1`,
      },
      {
        id: targetIssueId,
        companyId,
        title: "Target issue",
        status: "in_progress",
        priority: "medium",
        responsibleUserId: "responsible-user",
        assigneeAgentId: targetAgentId,
        issueNumber: 2,
        identifier: `${issuePrefix}-2`,
      },
    ]);
    await db.insert(heartbeatRuns).values([
      {
        id: originRunId,
        companyId,
        agentId: originAgentId,
        invocationSource: "assignment",
        triggerDetail: "system",
        status: "running",
        contextSnapshot: { issueId: originIssueId, taskId: originIssueId },
      },
      {
        id: targetRunId,
        companyId,
        agentId: targetAgentId,
        invocationSource: "assignment",
        triggerDetail: "system",
        status: "queued",
        contextSnapshot: { issueId: targetIssueId, taskId: targetIssueId },
      },
    ]);

    const service = issueReportService(db);
    await expect(service.resolveOrigin({ companyId, agentId: originAgentId, runId: originRunId }))
      .resolves.toBe(originIssueId);

    const input = {
      companyId,
      targetIssueId,
      originIssueId,
      originRunId,
      originAgentId,
      report: {
        fingerprint: "phase-1-audit",
        payload: {
          type: "audit.result",
          summary: "Phase 1 passed",
          data: { passed: true, checks: 7 },
        },
        requestWake: true,
      },
    } as const;
    const first = await service.create(input);
    const duplicate = await service.create(input);

    expect(first.deduplicated).toBe(false);
    expect(duplicate.deduplicated).toBe(true);
    expect(duplicate.report.id).toBe(first.report.id);
    expect(await db.select().from(issueReports).where(eq(issueReports.targetIssueId, targetIssueId)))
      .toHaveLength(1);

    const payload = await buildPaperclipWakePayload({
      db,
      companyId,
      runId: targetRunId,
      contextSnapshot: { issueId: targetIssueId, taskId: targetIssueId, wakeReason: "assignment" },
    });
    expect(payload?.reports).toEqual([
      expect.objectContaining({
        id: first.report.id,
        originIssueId,
        originRunId,
        originAgentId,
        fingerprint: "phase-1-audit",
        payload: expect.objectContaining({ type: "audit.result" }),
      }),
    ]);

    const consumed = await db.select().from(issueReports).where(eq(issueReports.id, first.report.id));
    expect(consumed[0]?.consumedByRunId).toBe(targetRunId);
    expect(consumed[0]?.consumedAt).not.toBeNull();

    const nextPayload = await buildPaperclipWakePayload({
      db,
      companyId,
      runId: randomUUID(),
      contextSnapshot: { issueId: targetIssueId, taskId: targetIssueId, wakeReason: "manual" },
    });
    expect(nextPayload?.reports).toEqual([]);
  });
});
