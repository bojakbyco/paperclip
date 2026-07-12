import { and, asc, eq, inArray, isNull } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { heartbeatRuns, issueReports, issues } from "@paperclipai/db";
import type { CreateIssueReport, IssueReport, IssueReportPayload } from "@paperclipai/shared";
import { conflict, unprocessable } from "../errors.js";

const ISSUE_REPORT_DELIVERY_FINGERPRINT_CONSTRAINT = "issue_reports_delivery_fingerprint_uq";
const DEFAULT_PENDING_REPORT_LIMIT = 50;

function readNonEmptyString(value: unknown) {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function readOriginIssueId(contextSnapshot: unknown) {
  if (!contextSnapshot || typeof contextSnapshot !== "object" || Array.isArray(contextSnapshot)) return null;
  const context = contextSnapshot as Record<string, unknown>;
  return readNonEmptyString(context.issueId) ?? readNonEmptyString(context.taskId);
}

function isFingerprintConflict(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const candidate = error as {
    code?: string;
    constraint?: string;
    constraint_name?: string;
    cause?: unknown;
  };
  if (
    candidate.code === "23505"
    && (candidate.constraint ?? candidate.constraint_name) === ISSUE_REPORT_DELIVERY_FINGERPRINT_CONSTRAINT
  ) return true;
  return candidate.cause ? isFingerprintConflict(candidate.cause) : false;
}

function hydrateReport(row: typeof issueReports.$inferSelect): IssueReport {
  return {
    ...row,
    payload: row.payload as IssueReportPayload,
  };
}

export function issueReportService(db: Db) {
  async function resolveOrigin(input: { companyId: string; agentId: string; runId: string }) {
    const run = await db
      .select({ contextSnapshot: heartbeatRuns.contextSnapshot })
      .from(heartbeatRuns)
      .where(and(
        eq(heartbeatRuns.id, input.runId),
        eq(heartbeatRuns.companyId, input.companyId),
        eq(heartbeatRuns.agentId, input.agentId),
      ))
      .then((rows) => rows[0] ?? null);
    if (!run) throw unprocessable("Report provenance requires a run owned by the actor");

    const originIssueId = readOriginIssueId(run.contextSnapshot);
    if (!originIssueId) throw unprocessable("Report provenance requires an issue-scoped run");

    const originIssue = await db
      .select({ id: issues.id })
      .from(issues)
      .where(and(eq(issues.id, originIssueId), eq(issues.companyId, input.companyId)))
      .then((rows) => rows[0] ?? null);
    if (!originIssue) throw unprocessable("Report origin issue is unavailable in this company");

    return originIssue.id;
  }

  async function create(input: {
    companyId: string;
    targetIssueId: string;
    originIssueId: string;
    originRunId: string;
    originAgentId: string;
    report: CreateIssueReport;
  }) {
    try {
      const created = await db
        .insert(issueReports)
        .values({
          companyId: input.companyId,
          targetIssueId: input.targetIssueId,
          originIssueId: input.originIssueId,
          originRunId: input.originRunId,
          originAgentId: input.originAgentId,
          fingerprint: input.report.fingerprint,
          payload: input.report.payload,
          wakeRequested: input.report.requestWake,
        })
        .returning()
        .then((rows) => rows[0] ?? null);
      if (!created) throw conflict("Issue report was not created");
      return { report: hydrateReport(created), deduplicated: false };
    } catch (error) {
      if (!isFingerprintConflict(error)) throw error;
      const existing = await db
        .select()
        .from(issueReports)
        .where(and(
          eq(issueReports.companyId, input.companyId),
          eq(issueReports.originIssueId, input.originIssueId),
          eq(issueReports.targetIssueId, input.targetIssueId),
          eq(issueReports.fingerprint, input.report.fingerprint),
        ))
        .then((rows) => rows[0] ?? null);
      if (!existing) throw conflict("Issue report fingerprint already exists");
      return { report: hydrateReport(existing), deduplicated: true };
    }
  }

  async function listForIssue(companyId: string, targetIssueId: string) {
    const rows = await db
      .select()
      .from(issueReports)
      .where(and(eq(issueReports.companyId, companyId), eq(issueReports.targetIssueId, targetIssueId)))
      .orderBy(asc(issueReports.createdAt), asc(issueReports.id));
    return rows.map(hydrateReport);
  }

  async function consumePending(input: {
    companyId: string;
    targetIssueId: string;
    runId: string;
    limit?: number;
  }) {
    return db.transaction(async (tx) => {
      const pending = await tx
        .select({ id: issueReports.id })
        .from(issueReports)
        .where(and(
          eq(issueReports.companyId, input.companyId),
          eq(issueReports.targetIssueId, input.targetIssueId),
          isNull(issueReports.consumedAt),
        ))
        .orderBy(asc(issueReports.createdAt), asc(issueReports.id))
        .limit(input.limit ?? DEFAULT_PENDING_REPORT_LIMIT)
        .for("update", { skipLocked: true });
      const ids = pending.map((row) => row.id);
      if (ids.length === 0) return [];
      const consumedAt = new Date();
      const rows = await tx
        .update(issueReports)
        .set({ consumedByRunId: input.runId, consumedAt, updatedAt: consumedAt })
        .where(and(inArray(issueReports.id, ids), isNull(issueReports.consumedAt)))
        .returning();
      return rows.map(hydrateReport);
    });
  }

  return { resolveOrigin, create, listForIssue, consumePending };
}
