import type { Db } from "@paperclipai/db";
import { agents } from "@paperclipai/db";
import { eq } from "drizzle-orm";

type AgentStatus = (typeof agents.$inferSelect)["status"];

export type AgentOrgRow = Pick<
  typeof agents.$inferSelect,
  "id" | "companyId" | "reportsTo" | "status"
>;

export type AgentInvokabilityBlockReason =
  | "missing"
  | "paused"
  | "terminated"
  | "pending_approval"
  | "manager_missing"
  | "manager_company_mismatch"
  | "manager_terminated"
  | "reporting_cycle"
  | "reporting_chain_too_deep";

export type AgentInvokability =
  | { invokable: true }
  | {
      invokable: false;
      reason: AgentInvokabilityBlockReason;
      message: string;
      details: Record<string, unknown>;
      invalidOrgChain: boolean;
    };

const DIRECT_NON_INVOKABLE_STATUSES = new Set<AgentStatus>([
  "paused",
  "terminated",
  "pending_approval",
]);

function blocked(
  reason: AgentInvokabilityBlockReason,
  message: string,
  details: Record<string, unknown>,
  invalidOrgChain = false,
): AgentInvokability {
  return { invokable: false, reason, message, details, invalidOrgChain };
}

function statusBlockReason(status: AgentStatus): AgentInvokabilityBlockReason | null {
  if (status === "paused") return "paused";
  if (status === "terminated") return "terminated";
  if (status === "pending_approval") return "pending_approval";
  return null;
}

export function evaluateAgentInvokability(
  agent: AgentOrgRow | null | undefined,
  companyAgents: AgentOrgRow[],
): AgentInvokability {
  if (!agent) {
    return blocked("missing", "Agent no longer exists", {}, false);
  }

  const directStatusReason = statusBlockReason(agent.status);
  if (directStatusReason) {
    return blocked(
      directStatusReason,
      "Agent is not invokable in its current state",
      { agentId: agent.id, agentStatus: agent.status },
      false,
    );
  }

  const byId = new Map(companyAgents.map((row) => [row.id, row]));
  const visited = new Set<string>([agent.id]);
  const reportingChainAgentIds: string[] = [];
  let managerId = agent.reportsTo;

  while (managerId) {
    if (visited.has(managerId)) {
      return blocked(
        "reporting_cycle",
        "Agent is not invokable because its reporting chain is invalid",
        { agentId: agent.id, managerId, reportingChainAgentIds },
        true,
      );
    }
    visited.add(managerId);

    if (reportingChainAgentIds.length >= 100) {
      return blocked(
        "reporting_chain_too_deep",
        "Agent is not invokable because its reporting chain is invalid",
        { agentId: agent.id, reportingChainAgentIds },
        true,
      );
    }

    const manager = byId.get(managerId);
    if (!manager) {
      return blocked(
        "manager_missing",
        "Agent is not invokable because its reporting chain is invalid",
        { agentId: agent.id, managerId, reportingChainAgentIds },
        true,
      );
    }

    reportingChainAgentIds.push(manager.id);
    if (manager.companyId !== agent.companyId) {
      return blocked(
        "manager_company_mismatch",
        "Agent is not invokable because its reporting chain is invalid",
        { agentId: agent.id, managerId: manager.id, managerCompanyId: manager.companyId },
        true,
      );
    }
    if (manager.status === "terminated") {
      return blocked(
        "manager_terminated",
        "Agent is not invokable because its reporting chain is invalid",
        {
          agentId: agent.id,
          managerId: manager.id,
          managerStatus: manager.status,
          reportingChainAgentIds,
        },
        true,
      );
    }

    managerId = manager.reportsTo;
  }

  return { invokable: true };
}

export async function evaluateAgentInvokabilityFromDb(
  db: Db,
  agent: AgentOrgRow | null | undefined,
): Promise<AgentInvokability> {
  if (!agent) return evaluateAgentInvokability(agent, []);
  const companyAgents = await db
    .select({
      id: agents.id,
      companyId: agents.companyId,
      reportsTo: agents.reportsTo,
      status: agents.status,
    })
    .from(agents)
    .where(eq(agents.companyId, agent.companyId));
  return evaluateAgentInvokability(agent, companyAgents);
}

export function listInvalidOrgChainDescendantIds(
  terminatedAgentId: string,
  companyAgents: AgentOrgRow[],
): string[] {
  const byManager = new Map<string | null, AgentOrgRow[]>();
  for (const row of companyAgents) {
    const siblings = byManager.get(row.reportsTo ?? null) ?? [];
    siblings.push(row);
    byManager.set(row.reportsTo ?? null, siblings);
  }

  const invalidDescendantIds: string[] = [];
  const stack = [...(byManager.get(terminatedAgentId) ?? [])];
  const seen = new Set<string>([terminatedAgentId]);
  while (stack.length > 0) {
    const current = stack.pop();
    if (!current || seen.has(current.id)) continue;
    seen.add(current.id);
    if (current.status !== "terminated") {
      invalidDescendantIds.push(current.id);
    }
    stack.push(...(byManager.get(current.id) ?? []));
  }
  return invalidDescendantIds;
}

export function shouldCancelRunsForNonInvokableAgent(result: AgentInvokability) {
  return !result.invokable && (result.reason === "terminated" || result.invalidOrgChain);
}
