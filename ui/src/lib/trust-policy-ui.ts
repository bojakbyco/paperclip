import {
  DEFAULT_TRUST_PRESET,
  LOW_TRUST_REVIEW_PRESET,
  LOW_TRUST_REVIEW_PRESET_VERSION,
  LOW_TRUST_REVIEW_RAW_OUTPUT_DISPOSITION,
  type AgentPermissions,
  type LowTrustBoundary,
  type SourceTrustMetadata,
  type TrustAuthorizationPolicy,
  type TrustPreset,
} from "@paperclipai/shared";

export const TRUST_PRESET_LABELS: Record<TrustPreset, string> = {
  standard: "Standard",
  low_trust_review: "Low-trust review",
};

export const TRUST_PRESET_DESCRIPTIONS: Record<TrustPreset, string> = {
  standard: "Company-visible collaboration. This is the default for normal work.",
  low_trust_review:
    "Contained for hostile or untrusted input. Narrow Paperclip API, quarantined output. Use for PR review and external-content triage.",
};

export function getTrustPreset(permissions: Partial<AgentPermissions> | null | undefined): TrustPreset {
  return permissions?.trustPreset === LOW_TRUST_REVIEW_PRESET ? LOW_TRUST_REVIEW_PRESET : DEFAULT_TRUST_PRESET;
}

export function buildLowTrustReviewPolicy(
  existing: TrustAuthorizationPolicy | null | undefined,
): TrustAuthorizationPolicy {
  return {
    ...(existing ?? {}),
    trustPreset: LOW_TRUST_REVIEW_PRESET,
    reviewPreset: {
      id: LOW_TRUST_REVIEW_PRESET,
      version: LOW_TRUST_REVIEW_PRESET_VERSION,
      rawOutputDisposition: LOW_TRUST_REVIEW_RAW_OUTPUT_DISPOSITION,
    },
  };
}

export function buildPermissionsForTrustPreset(
  permissions: Partial<AgentPermissions> | null | undefined,
  preset: TrustPreset,
): Partial<AgentPermissions> {
  const current = permissions ?? {};
  if (preset === LOW_TRUST_REVIEW_PRESET) {
    return {
      ...current,
      trustPreset: LOW_TRUST_REVIEW_PRESET,
      authorizationPolicy: buildLowTrustReviewPolicy(current.authorizationPolicy),
    };
  }

  const nextPolicy = { ...(current.authorizationPolicy ?? {}) } as TrustAuthorizationPolicy;
  delete nextPolicy.trustPreset;
  delete nextPolicy.reviewPreset;
  delete nextPolicy.trustBoundary;

  return {
    ...current,
    trustPreset: DEFAULT_TRUST_PRESET,
    ...(Object.keys(nextPolicy).length > 0
      ? { authorizationPolicy: nextPolicy }
      : { authorizationPolicy: undefined }),
  };
}

export function getLowTrustBoundary(
  permissions: Partial<AgentPermissions> | null | undefined,
): LowTrustBoundary | null {
  const boundary = permissions?.authorizationPolicy?.trustBoundary;
  return boundary?.mode === LOW_TRUST_REVIEW_PRESET ? boundary : null;
}

export function lowTrustBoundaryHasScope(boundary: LowTrustBoundary | null | undefined) {
  return Boolean(
    boundary?.projectIds?.length ||
    boundary?.rootIssueId ||
    boundary?.issueIds?.length,
  );
}

export function sourceTrustLabel(sourceTrust: SourceTrustMetadata | null | undefined) {
  if (!sourceTrust || sourceTrust.preset !== LOW_TRUST_REVIEW_PRESET) return null;
  if (sourceTrust.disposition === "promoted") return "Promoted from low-trust";
  return "Low-trust source";
}
