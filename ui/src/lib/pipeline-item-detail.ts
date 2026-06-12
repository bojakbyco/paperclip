import type { PipelineCase, PipelineCaseEvent, PipelineStage } from "../api/pipelines";

export const INTERNAL_FIELD_KEYS = new Set([
  "nextSuggestedStageId",
  "suggestionResolution",
  "upstreamDrift",
  "upstreamChanged",
  "changeAcknowledgedAt",
  "thisChanged",
]);

type StageLookup = Map<string, string> | Record<string, string> | PipelineStage[] | undefined;

function readString(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function readRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function stageNameFromLookup(stages: StageLookup, keyOrId: string | null | undefined) {
  if (!keyOrId) return null;
  if (!stages) return null;
  if (Array.isArray(stages)) {
    const stage = stages.find((candidate) => candidate.key === keyOrId || candidate.id === keyOrId);
    return stage?.name ?? null;
  }
  if (stages instanceof Map) return stages.get(keyOrId) ?? null;
  return stages[keyOrId] ?? null;
}

function humanizeKey(key: string) {
  return key
    .replace(/[_-]+/g, " ")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .trim()
    .replace(/\s+/g, " ")
    .replace(/^./, (char) => char.toUpperCase());
}

export function humanizePipelineItemStatus(status: string | null | undefined) {
  if (!status) return "Open";
  const normalized = status.trim().toLowerCase();
  if (!normalized) return "Open";
  const labels: Record<string, string> = {
    open: "Open",
    working: "In progress",
    done: "Done",
    cancelled: "Removed",
    in_review: "In review",
    review: "In review",
    in_progress: "In progress",
  };
  return labels[normalized] ?? humanizeKey(normalized);
}

export function formatFieldValue(value: unknown): string {
  if (Array.isArray(value)) {
    const formatted = value.map(formatFieldValue).filter(Boolean);
    return formatted.length ? formatted.join(", ") : "None";
  }
  if (value == null || value === "") return "None";
  if (typeof value === "boolean") return value ? "Yes" : "No";
  if (typeof value === "number") return String(value);
  if (typeof value === "string") return value;
  const record = readRecord(value);
  if (record) {
    return readString(record.label) ?? readString(record.name) ?? readString(record.title) ?? "Added details";
  }
  return String(value);
}

export function displayPipelineItemFields(fields: Record<string, unknown> | null | undefined) {
  return Object.entries(fields ?? {})
    .filter(([key]) => !INTERNAL_FIELD_KEYS.has(key))
    .map(([key, value]) => ({
      key,
      label: humanizeKey(key),
      value: formatFieldValue(value),
    }));
}

export function getPendingTransitionBannerState(item: Pick<PipelineCase, "pendingSuggestion" | "fields">, stages?: StageLookup) {
  const fields = item.fields ?? {};
  if (fields.suggestionResolution || fields.changeAcknowledgedAt) {
    return { visible: false as const, reason: "resolved" as const };
  }
  const suggestion = item.pendingSuggestion ?? null;
  const toStageKey = suggestion?.toStageKey ?? readString(fields.nextSuggestedStageId);
  if (!toStageKey) return { visible: false as const, reason: "no_next_stage" as const };
  return {
    visible: true as const,
    suggestionId: suggestion?.id ?? null,
    toStageKey,
    stageName: stageNameFromLookup(stages, toStageKey) ?? "the next stage",
    rationale: suggestion?.rationale ?? null,
  };
}

export function itemHasChangedNotice(item: Pick<PipelineCase, "fields"> & {
  thisChanged?: unknown;
  changeAcknowledgedAt?: unknown;
}) {
  const fields = item.fields ?? {};
  if (item.changeAcknowledgedAt || fields.changeAcknowledgedAt) return null;
  if (item.thisChanged || fields.thisChanged || fields.upstreamChanged || fields.upstreamDrift) {
    return {
      title: "This changed",
      body: "Upstream work changed after this item was created. Review the latest details before continuing.",
    };
  }
  return null;
}

export function eventsHaveUnacknowledgedDrift(events: PipelineCaseEvent[]) {
  const latestAcknowledgedAt = events
    .filter((event) => event.type === "drift_acknowledged")
    .map((event) => new Date(event.createdAt).getTime())
    .filter((time) => Number.isFinite(time))
    .reduce((latest, time) => Math.max(latest, time), 0);

  return events.some((event) => {
    if (event.type !== "upstream_drift") return false;
    const createdAt = new Date(event.createdAt).getTime();
    return Number.isFinite(createdAt) && createdAt > latestAcknowledgedAt;
  });
}

export function changedNoticeFromEvents(events: PipelineCaseEvent[]) {
  if (!eventsHaveUnacknowledgedDrift(events)) return null;
  return {
    title: "This changed",
    body: "Upstream work changed after this item was created. Review the latest details before continuing.",
  };
}

function stageName(event: Pick<PipelineCaseEvent, "fromStageId" | "toStageId">, stages: StageLookup, side: "from" | "to") {
  const stageId = side === "from" ? event.fromStageId : event.toStageId;
  return stageNameFromLookup(stages, stageId ?? undefined);
}

function readDecision(payload: Record<string, unknown>) {
  return readString(payload.decision)?.toLowerCase() ?? null;
}

export function formatPipelineItemEvent(event: PipelineCaseEvent, stages?: StageLookup) {
  const kind = event.type.startsWith("case.") ? event.type.slice("case.".length) : event.type;
  const payload = event.payload ?? {};
  if (kind === "ingested") return "Item added.";
  if (kind === "updated") return "Item details updated.";
  if (kind === "transitioned") {
    const from = stageName(event, stages, "from");
    const to = stageName(event, stages, "to");
    if (from && to) return `Moved from ${from} to ${to}.`;
    if (to) return `Moved to ${to}.`;
    return "Moved to another stage.";
  }
  if (kind === "suggested" || kind === "transition_suggested") {
    const suggestion = readRecord(payload.suggestion);
    const toStageKey = readString(suggestion?.toStageKey) ?? readString(payload.toStageKey);
    const to = stageNameFromLookup(stages, toStageKey) ?? "the next stage";
    return `Suggested moving to ${to}.`;
  }
  if (kind === "suggestion_resolved") {
    const decision = readDecision(payload);
    if (decision === "accept") return "Suggestion approved.";
    if (decision === "dismiss") return "Suggestion dismissed.";
    return "Suggestion resolved.";
  }
  if (kind === "reviewed" || kind === "review_decided") {
    const decision = readDecision(payload);
    if (decision === "request_changes") return "Review requested changes.";
    if (decision === "drop" || decision === "reject") return "Review removed this item.";
    if (decision === "approve") return "Review approved this item.";
    return "Review completed.";
  }
  if (kind === "conversation_opened") return "Conversation started.";
  if (kind === "issue_linked") return "Linked to work.";
  if (kind === "issue_unlinked") return "Work link removed.";
  if (kind === "blockers_set") return "Waiting items updated.";
  if (kind === "blockers_resolved") return "Waiting items cleared.";
  if (kind === "children_terminal") return "Built-from items completed.";
  if (kind === "upstream_drift") {
    const upstreamCaseKey = readString(payload.upstreamCaseKey);
    if (upstreamCaseKey) return `Upstream change detected from ${upstreamCaseKey}.`;
    return "Upstream change detected.";
  }
  if (kind === "drift_acknowledged") return "Upstream change acknowledged.";
  if (kind === "automation_executed") return "Automation completed.";
  if (kind === "automation_failed") return "Automation needs attention.";
  if (kind === "claimed") return "Work started.";
  if (kind === "lease_released" || kind === "lease_expired") return "Work handoff cleared.";
  return "Activity recorded.";
}
