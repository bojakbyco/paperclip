import { and, eq, or, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { agents } from "@paperclipai/db";
import { HttpError } from "../errors.js";

type BuiltInAgentKey = "briefs";

interface BuiltInAgentDefinition {
  key: BuiltInAgentKey;
  displayName: string;
  featureKeys: string[];
}

const BUILT_IN_AGENT_DEFINITIONS: Record<BuiltInAgentKey, BuiltInAgentDefinition> = {
  briefs: {
    key: "briefs",
    displayName: "Briefs Agent",
    featureKeys: ["briefs"],
  },
};

function missingBuiltInAgent(definition: BuiltInAgentDefinition) {
  return new HttpError(412, `Built-in agent is not configured: ${definition.key}`, {
    code: "built_in_agent_not_configured",
    key: definition.key,
    status: "not_provisioned",
    agentId: null,
    featureKeys: definition.featureKeys,
  });
}

function builtInPausedWarning(definition: BuiltInAgentDefinition, agent: typeof agents.$inferSelect) {
  return {
    code: "built_in_agent_paused" as const,
    key: definition.key,
    agentId: agent.id,
    message: `${definition.displayName} is paused.`,
    pauseReason: agent.pauseReason,
  };
}

export function builtInAgentService(db: Db) {
  return {
    async requireBuiltInAgent(companyId: string, key: BuiltInAgentKey) {
      const definition = BUILT_IN_AGENT_DEFINITIONS[key];
      if (!definition) throw new HttpError(404, `Unknown built-in agent: ${key}`);

      const [agent] = await db.select()
        .from(agents)
        .where(and(
          eq(agents.companyId, companyId),
          or(
            sql`${agents.metadata}->'paperclipBuiltInAgent'->>'key' = ${key}`,
            sql`${agents.metadata}->>'builtInAgentKey' = ${key}`,
          ),
        ))
        .limit(1);

      if (!agent) throw missingBuiltInAgent(definition);

      return {
        definition,
        agent,
        warning: agent.status === "paused" ? builtInPausedWarning(definition, agent) : null,
      };
    },
  };
}
