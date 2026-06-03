import { useMemo, useState } from "react";
import type { AgentPermissions, TrustPreset } from "@paperclipai/shared";
import { Lock, ShieldAlert } from "lucide-react";
import { Field, CollapsibleSection } from "./agent-config-primitives";
import {
  buildPermissionsForTrustPreset,
  getLowTrustBoundary,
  getTrustPreset,
  lowTrustBoundaryHasScope,
  TRUST_PRESET_DESCRIPTIONS,
  TRUST_PRESET_LABELS,
} from "../lib/trust-policy-ui";
import { cn } from "../lib/utils";

const inputClass =
  "w-full rounded-md border border-border px-2.5 py-1.5 bg-transparent outline-none text-sm font-mono placeholder:text-muted-foreground/40";

function formatCount(value: readonly unknown[] | undefined, singular: string, plural: string) {
  const count = value?.length ?? 0;
  if (count === 0) return "-";
  return `${count} ${count === 1 ? singular : plural}`;
}

function PolicyRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-start justify-between gap-3 py-1.5 text-sm">
      <span className="shrink-0 text-xs text-muted-foreground">{label}</span>
      <span className={cn("min-w-0 text-right", value === "-" && "text-muted-foreground")}>{value}</span>
    </div>
  );
}

export function TrustPresetSection({
  permissions,
  onChange,
  disabled,
}: {
  permissions: Partial<AgentPermissions> | null | undefined;
  onChange: (permissions: Partial<AgentPermissions>) => void;
  disabled?: boolean;
}) {
  const [policyOpen, setPolicyOpen] = useState(false);
  const preset = getTrustPreset(permissions);
  const boundary = getLowTrustBoundary(permissions);
  const lowTrust = preset === "low_trust_review";
  const hasScope = lowTrustBoundaryHasScope(boundary);
  const policy = permissions?.authorizationPolicy ?? null;
  const managedPermissions = useMemo(
    () => buildPermissionsForTrustPreset(permissions, preset),
    [permissions, preset],
  );

  function handlePresetChange(value: string) {
    const nextPreset: TrustPreset = value === "low_trust_review" ? "low_trust_review" : "standard";
    onChange(buildPermissionsForTrustPreset(permissions, nextPreset));
  }

  return (
    <div>
      <h3 className="mb-3 text-sm font-medium">Trust</h3>
      <div className="rounded-lg border border-border p-4 space-y-3">
        <Field label="Trust preset" hint="Choose how broadly this agent can read and act on Paperclip work objects.">
          <select
            className={inputClass}
            value={preset}
            onChange={(event) => handlePresetChange(event.target.value)}
            disabled={disabled}
          >
            <option value="standard">{TRUST_PRESET_LABELS.standard}</option>
            <option value="low_trust_review">{TRUST_PRESET_LABELS.low_trust_review}</option>
          </select>
        </Field>
        <p className="text-xs text-muted-foreground">{TRUST_PRESET_DESCRIPTIONS[preset]}</p>

        {lowTrust ? (
          <div
            role={hasScope ? "status" : "alert"}
            aria-live="polite"
            className={cn(
              "rounded-md border px-3 py-2.5 text-sm flex gap-2",
              hasScope
                ? "border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-100"
                : "border-destructive/30 bg-destructive/10 text-destructive",
            )}
          >
            {hasScope ? (
              <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0" />
            ) : (
              <Lock className="mt-0.5 h-4 w-4 shrink-0" />
            )}
            <div className="min-w-0 flex-1 space-y-2">
              <div>
                <p className="font-medium">
                  {hasScope ? "Containment active" : "Containment not configured"}
                </p>
                <p className="mt-1 text-xs leading-5">
                  {hasScope
                    ? "This agent can only read and mutate work inside its assigned review boundary. Raw output is quarantined from higher-trust agents until a trusted reviewer promotes it."
                    : "This agent is set to low-trust review, but no project, root issue, or issue scope is set in the core policy. Add a scope before this agent can run without denial."}
                </p>
              </div>
              <CollapsibleSection
                title="View policy"
                open={policyOpen}
                onToggle={() => setPolicyOpen((open) => !open)}
              >
                <div className="divide-y divide-border/60 text-foreground">
                  <PolicyRow label="Preset" value="Low-trust review v1" />
                  <PolicyRow label="Raw output" value="Quarantined from higher-trust agents" />
                  <PolicyRow label="Projects" value={formatCount(boundary?.projectIds, "project", "projects")} />
                  <PolicyRow label="Root issue" value={boundary?.rootIssueId ? boundary.rootIssueId.slice(0, 8) : "-"} />
                  <PolicyRow label="Explicit issues" value={formatCount(boundary?.issueIds, "issue", "issues")} />
                  <PolicyRow label="Allowed agents" value={formatCount(boundary?.allowedAgentIds, "agent", "agents")} />
                  <PolicyRow label="Allowed tools" value={boundary?.allowedToolClasses?.join(" · ") || "-"} />
                  <PolicyRow label="Allowed secrets" value={formatCount(boundary?.allowedSecretBindingIds, "binding", "bindings")} />
                  <PolicyRow label="Promotion target" value={boundary?.outputPromotionTarget?.issueId?.slice(0, 8) ?? "-"} />
                  <PolicyRow
                    label="EE fields"
                    value={Object.keys(policy ?? {}).some((key) => !["trustPreset", "reviewPreset", "trustBoundary"].includes(key))
                      ? "Custom advanced policy fields preserved"
                      : "-"}
                  />
                </div>
              </CollapsibleSection>
            </div>
          </div>
        ) : null}

        {managedPermissions.authorizationPolicy?.reviewPreset ? null : (
          <p className="text-xs text-muted-foreground">
            Advanced permissions remain editable through the EE permissions extension when installed.
          </p>
        )}
      </div>
    </div>
  );
}
