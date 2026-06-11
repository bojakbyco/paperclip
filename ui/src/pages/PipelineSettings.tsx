import { useEffect, useMemo, useState, type FormEvent, type ReactNode } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { Agent } from "@paperclipai/shared";
import {
  AlertTriangle,
  Archive,
  Check,
  GitBranch,
  Hexagon,
  Plus,
  Save,
  Trash2,
} from "lucide-react";
import { agentsApi } from "../api/agents";
import { accessApi, type CompanyUserDirectoryEntry } from "../api/access";
import { ApiError } from "../api/client";
import type { PipelineDetail, PipelineStage, PipelineTransitionEdge } from "../api/pipelines";
import { pipelinesApi } from "../api/pipelines";
import { EmptyState } from "../components/EmptyState";
import { PageSkeleton } from "../components/PageSkeleton";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { ToggleSwitch } from "@/components/ui/toggle-switch";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { useCompany } from "../context/CompanyContext";
import { useToastActions } from "../context/ToastContext";
import { queryKeys } from "../lib/queryKeys";
import { cn } from "../lib/utils";
import { Link, useNavigate, useParams } from "@/lib/router";

type SettingsTab = "stages" | "guidance" | "advanced";
type VariableType = "text" | "multiline" | "select";
type ApproverKind = "any_human" | "user" | "agent";

type StageConfig = {
  variables?: Array<{
    key: string;
    label: string;
    type?: VariableType;
    options?: string[];
    required?: boolean;
    showInAddForm?: boolean;
  }>;
  disabled?: boolean;
  disabledReason?: string | null;
  requireApproval?: boolean;
  approver?: {
    kind?: ApproverKind;
    id?: string | null;
  };
  reviewerKind?: string;
  whatHappensHere?: string;
  approveToStageKey?: string;
  rejectToStageKey?: string;
  requestChangesToStageKey?: string;
  requireRejectReason?: boolean;
  [key: string]: unknown;
};

type EditorVariable = {
  id: string;
  key: string;
  label: string;
  type: VariableType;
  optionsText: string;
  required: boolean;
  showInAddForm: boolean;
};

const TAB_LABELS: Array<{ id: SettingsTab; label: string }> = [
  { id: "stages", label: "Stages" },
  { id: "guidance", label: "Guidance" },
  { id: "advanced", label: "Advanced" },
];

const PIPELINE_GUIDANCE_KEY = "guidance";

function stageConfig(stage: PipelineStage | null | undefined): StageConfig {
  const config = stage?.config;
  if (!config || typeof config !== "object" || Array.isArray(config)) {
    return { variables: [] };
  }
  return config as StageConfig;
}

function stageNewEntriesDisabled(stage: PipelineStage | null | undefined) {
  return stageConfig(stage).disabled === true;
}

function variableRows(stage: PipelineStage | null | undefined): EditorVariable[] {
  return (stageConfig(stage).variables ?? []).map((variable, index) => ({
    id: `${variable.key || "variable"}-${index}`,
    key: variable.key,
    label: variable.label,
    type: variable.type ?? "text",
    optionsText: (variable.options ?? []).join(", "),
    required: Boolean(variable.required),
    showInAddForm: Boolean(variable.showInAddForm),
  }));
}

function cleanVariables(variables: EditorVariable[]) {
  return variables
    .map((variable) => {
      const type = variable.type;
      const options = type === "select"
        ? variable.optionsText
          .split(",")
          .map((option) => option.trim())
          .filter(Boolean)
        : [];
      return {
        key: variable.key.trim(),
        label: variable.label.trim() || variable.key.trim(),
        type,
        options,
        required: variable.required,
        showInAddForm: variable.showInAddForm,
      };
    })
    .filter((variable) => variable.key);
}

function approvalValue(config: StageConfig) {
  const approver = config.approver;
  if (!approver || !approver.kind || approver.kind === "any_human") {
    return "any_human";
  }
  if ((approver.kind === "user" || approver.kind === "agent") && approver.id) {
    return `${approver.kind}:${approver.id}`;
  }
  return "any_human";
}

function parseApprovalValue(value: string): { kind: ApproverKind; id: string | null } {
  if (value === "any_human") {
    return { kind: "any_human", id: null };
  }
  const [kind, id] = value.split(":", 2);
  if ((kind === "user" || kind === "agent") && id) {
    return { kind, id };
  }
  return { kind: "any_human", id: null };
}

export function stageKeyFromName(name: string) {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 60)
    .replace(/_+$/g, "");
  return slug || "stage";
}

function nextStageKey(name: string, existingKeys: Set<string>) {
  const base = stageKeyFromName(name);
  if (!existingKeys.has(base)) return base;
  return `${base}_${Date.now().toString(36)}`;
}

function sortedStages(pipeline: PipelineDetail | null | undefined) {
  return [...(pipeline?.stages ?? [])].sort((left, right) => left.position - right.position);
}

function defaultReviewTarget(stages: PipelineStage[], selectedStageId: string | null, kind: string) {
  const match = stages.find((stage) => stage.kind === kind && stage.id !== selectedStageId);
  if (match) return match.key;
  const fallback = stages.find((stage) => stage.id !== selectedStageId);
  return fallback?.key ?? "";
}

function dedupeEdges(edges: PipelineTransitionEdge[]) {
  const seen = new Set<string>();
  return edges.filter((edge) => {
    if (edge.fromStageKey === edge.toStageKey) return false;
    const key = `${edge.fromStageKey}:${edge.toStageKey}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function humanLabel(entry: CompanyUserDirectoryEntry) {
  return entry.user?.name || entry.user?.email || entry.principalId;
}

function agentLabel(agent: Agent) {
  return agent.name || agent.role || agent.id;
}

function Section({
  title,
  children,
}: {
  title: string;
  children: ReactNode;
}) {
  return (
    <section className="space-y-3 border-t border-border pt-5">
      <h2 className="text-sm font-semibold text-foreground">{title}</h2>
      {children}
    </section>
  );
}

export function PipelineSettings() {
  const { pipelineId } = useParams<{ pipelineId: string }>();
  const { selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const { pushToast } = useToastActions();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [activeTab, setActiveTab] = useState<SettingsTab>("stages");
  const [selectedStageId, setSelectedStageId] = useState<string | null>(null);
  const [stageName, setStageName] = useState("");
  const [stageKind, setStageKind] = useState("open");
  const [newEntriesDisabled, setNewEntriesDisabled] = useState(false);
  const [disableReason, setDisableReason] = useState("");
  const [approvalRequired, setApprovalRequired] = useState(false);
  const [selectedApproval, setSelectedApproval] = useState("any_human");
  const [whatHappensHere, setWhatHappensHere] = useState("");
  const [approveTarget, setApproveTarget] = useState("");
  const [rejectTarget, setRejectTarget] = useState("");
  const [requestChangesTarget, setRequestChangesTarget] = useState("");
  const [requireRejectReason, setRequireRejectReason] = useState(true);
  const [variables, setVariables] = useState<EditorVariable[]>([]);
  const [transitionTargets, setTransitionTargets] = useState<Set<string>>(() => new Set());
  const [guidanceBody, setGuidanceBody] = useState("");
  const [pipelineName, setPipelineName] = useState("");
  const [pipelineDescription, setPipelineDescription] = useState("");
  const [archiveConfirmation, setArchiveConfirmation] = useState("");

  const pipelineQuery = useQuery({
    queryKey: pipelineId ? queryKeys.pipelines.detail(pipelineId) : ["pipelines", "detail", "none"],
    queryFn: () => pipelinesApi.get(pipelineId!),
    enabled: !!pipelineId && !!selectedCompanyId,
  });

  const guidanceQuery = useQuery({
    queryKey: pipelineId
      ? queryKeys.pipelines.document(pipelineId, PIPELINE_GUIDANCE_KEY)
      : ["pipelines", "document", "none"],
    queryFn: async () => {
      try {
        return await pipelinesApi.getDocument(pipelineId!, PIPELINE_GUIDANCE_KEY);
      } catch (error) {
        if (error instanceof ApiError && error.status === 404) return null;
        throw error;
      }
    },
    enabled: !!pipelineId && !!selectedCompanyId,
  });

  const agentsQuery = useQuery({
    queryKey: selectedCompanyId ? queryKeys.agents.list(selectedCompanyId) : ["agents", "none"],
    queryFn: () => agentsApi.list(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });

  const usersQuery = useQuery({
    queryKey: selectedCompanyId ? queryKeys.access.companyUserDirectory(selectedCompanyId) : ["access", "users", "none"],
    queryFn: () => accessApi.listUserDirectory(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });

  const pipeline = pipelineQuery.data ?? null;
  const stages = useMemo(() => sortedStages(pipeline), [pipeline]);
  const selectedStage = stages.find((stage) => stage.id === selectedStageId) ?? stages[0] ?? null;
  const guidanceDocument = guidanceQuery.data ?? null;
  const savedGuidanceBody = guidanceDocument
    ? guidanceDocument.revision?.body ?? guidanceDocument.document?.latestBody ?? ""
    : "";

  useEffect(() => {
    if (!pipeline) return;
    setBreadcrumbs([
      { label: "Pipelines", href: "/pipelines" },
      { label: pipeline.name, href: `/pipelines/${pipeline.id}` },
      { label: "Settings" },
    ]);
  }, [pipeline, setBreadcrumbs]);

  useEffect(() => {
    if (!selectedStageId && stages[0]) {
      setSelectedStageId(stages[0].id);
    }
  }, [selectedStageId, stages]);

  useEffect(() => {
    if (!selectedStage) return;
    const config = stageConfig(selectedStage);
    setStageName(selectedStage.name);
    setStageKind(selectedStage.kind);
    setNewEntriesDisabled(stageNewEntriesDisabled(selectedStage));
    setDisableReason(config.disabledReason ?? "");
    setApprovalRequired(Boolean(config.requireApproval));
    setSelectedApproval(approvalValue(config));
    setWhatHappensHere(config.whatHappensHere ?? "");
    setApproveTarget(config.approveToStageKey ?? "");
    setRejectTarget(config.rejectToStageKey ?? "");
    setRequestChangesTarget(config.requestChangesToStageKey ?? "");
    setRequireRejectReason(config.requireRejectReason ?? true);
    setVariables(variableRows(selectedStage));
    setTransitionTargets(
      new Set(
        (pipeline?.transitions ?? [])
          .filter((transition) => transition.fromStageId === selectedStage.id)
          .map((transition) => transition.toStageId),
      ),
    );
  }, [pipeline?.transitions, selectedStage]);

  useEffect(() => {
    setGuidanceBody(savedGuidanceBody);
  }, [savedGuidanceBody]);

  useEffect(() => {
    if (!pipeline) return;
    setPipelineName(pipeline.name);
    setPipelineDescription(pipeline.description ?? "");
  }, [pipeline]);

  const refreshPipeline = async () => {
    if (!pipelineId) return;
    await queryClient.invalidateQueries({ queryKey: queryKeys.pipelines.detail(pipelineId) });
    await queryClient.invalidateQueries({ queryKey: queryKeys.pipelines.intakeForm(pipelineId) });
  };

  const saveStage = useMutation({
    mutationFn: async () => {
      if (!pipelineId || !selectedStage || !pipeline) return null;
      const parsedApproval = parseApprovalValue(selectedApproval);
      const config: StageConfig = {
        ...stageConfig(selectedStage),
        variables: cleanVariables(variables),
        disabled: newEntriesDisabled,
        disabledReason: newEntriesDisabled ? disableReason.trim() || null : null,
        requireApproval: approvalRequired,
        approver: approvalRequired && parsedApproval.kind !== "any_human"
          ? { kind: parsedApproval.kind, id: parsedApproval.id }
          : { kind: "any_human" },
        whatHappensHere: whatHappensHere.trim(),
      };
      // The approval model replaces the legacy reviewerKind input.
      delete config.reviewerKind;
      if (stageKind === "review") {
        config.approveToStageKey = approveTarget;
        config.rejectToStageKey = rejectTarget;
        if (requestChangesTarget) {
          config.requestChangesToStageKey = requestChangesTarget;
        } else {
          delete config.requestChangesToStageKey;
        }
        config.requireRejectReason = requireRejectReason;
      }

      const keyById = new Map(stages.map((stage) => [stage.id, stage.key]));
      const existingTransitions = pipeline.transitions ?? [];
      const retainedEdges = existingTransitions
        .filter((transition) => transition.fromStageId !== selectedStage.id)
        .flatMap((transition) => {
          const fromStageKey = keyById.get(transition.fromStageId);
          const toStageKey = keyById.get(transition.toStageId);
          if (!fromStageKey || !toStageKey) return [];
          return [{ fromStageKey, toStageKey, label: transition.label ?? null }];
        });
      const selectedEdges = [...transitionTargets].flatMap((targetId) => {
        const toStageKey = keyById.get(targetId);
        if (!toStageKey) return [];
        const prior = existingTransitions.find(
          (transition) => transition.fromStageId === selectedStage.id && transition.toStageId === targetId,
        );
        return [{ fromStageKey: selectedStage.key, toStageKey, label: prior?.label ?? null }];
      });

      await pipelinesApi.updateStage(pipelineId, selectedStage.id, {
        name: stageName.trim(),
        kind: stageKind,
        config,
      });
      await pipelinesApi.setTransitions(pipelineId, {
        transitions: dedupeEdges([...retainedEdges, ...selectedEdges]),
      });
      return null;
    },
    onSuccess: async () => {
      await refreshPipeline();
      pushToast({ title: "Stage saved", tone: "success" });
    },
  });

  const addStage = useMutation({
    mutationFn: async (afterStage: PipelineStage | null) => {
      if (!pipelineId || !pipeline) return null;
      const lastStage = stages[stages.length - 1] ?? null;
      const insertPosition = afterStage ? afterStage.position + 1 : (lastStage ? lastStage.position + 100 : 100);
      const nextStage = afterStage
        ? stages.find((stage) => stage.position > afterStage.position) ?? null
        : null;
      const existingKeys = new Set(stages.map((stage) => stage.key));
      const created = await pipelinesApi.createStage(pipelineId, {
        key: nextStageKey("New stage", existingKeys),
        name: "New stage",
        kind: "working",
        position: insertPosition,
        config: { variables: [] },
      });
      if (afterStage) {
        const keyById = new Map(stages.map((stage) => [stage.id, stage.key]));
        const existingTransitions = pipeline.transitions ?? [];
        const edges = existingTransitions
          .filter(
            (transition) => !(nextStage && transition.fromStageId === afterStage.id && transition.toStageId === nextStage.id),
          )
          .flatMap((transition) => {
            const fromStageKey = keyById.get(transition.fromStageId);
            const toStageKey = keyById.get(transition.toStageId);
            if (!fromStageKey || !toStageKey) return [];
            return [{ fromStageKey, toStageKey, label: transition.label ?? null }];
          });
        edges.push({ fromStageKey: afterStage.key, toStageKey: created.key, label: null });
        if (nextStage) {
          edges.push({ fromStageKey: created.key, toStageKey: nextStage.key, label: null });
        }
        await pipelinesApi.setTransitions(pipelineId, { transitions: dedupeEdges(edges) });
      }
      return created;
    },
    onSuccess: async (created) => {
      await refreshPipeline();
      if (created) {
        setSelectedStageId(created.id);
      }
      pushToast({ title: "Stage added", tone: "success" });
    },
  });

  const saveGuidance = useMutation({
    mutationFn: () =>
      pipelinesApi.upsertDocument(pipelineId!, PIPELINE_GUIDANCE_KEY, {
        title: "Pipeline guidance",
        body: guidanceBody.trim(),
      }),
    onSuccess: async () => {
      if (pipelineId) {
        await queryClient.invalidateQueries({
          queryKey: queryKeys.pipelines.document(pipelineId, PIPELINE_GUIDANCE_KEY),
        });
      }
      await refreshPipeline();
      pushToast({ title: "Guidance saved", tone: "success" });
    },
  });

  const savePipelineDetails = useMutation({
    mutationFn: () =>
      pipelinesApi.update(pipelineId!, {
        name: pipelineName.trim(),
        description: pipelineDescription.trim() || null,
      }),
    onSuccess: async () => {
      await refreshPipeline();
      if (selectedCompanyId) {
        await queryClient.invalidateQueries({ queryKey: queryKeys.pipelines.list(selectedCompanyId) });
      }
      pushToast({ title: "Pipeline updated", tone: "success" });
    },
  });

  const archivePipeline = useMutation({
    mutationFn: (archived: boolean) => pipelinesApi.update(pipelineId!, { archived }),
    onSuccess: async (_result, archived) => {
      if (selectedCompanyId) {
        await queryClient.invalidateQueries({ queryKey: queryKeys.pipelines.list(selectedCompanyId) });
      }
      if (archived) {
        navigate("/pipelines");
      } else {
        await refreshPipeline();
        pushToast({ title: "Pipeline restored", tone: "success" });
      }
    },
  });

  const addVariable = () => {
    const nextIndex = variables.length + 1;
    setVariables((current) => [
      ...current,
      {
        id: `new-${Date.now()}`,
        key: `field_${nextIndex}`,
        label: `Field ${nextIndex}`,
        type: "text",
        optionsText: "",
        required: false,
        showInAddForm: true,
      },
    ]);
  };

  const updateVariable = (id: string, patch: Partial<EditorVariable>) => {
    setVariables((current) =>
      current.map((variable) => variable.id === id ? { ...variable, ...patch } : variable),
    );
  };

  const setStageKindWithDefaults = (kind: string) => {
    setStageKind(kind);
    if (kind === "review") {
      setApproveTarget((current) => current || defaultReviewTarget(stages, selectedStage?.id ?? null, "done"));
      setRejectTarget((current) => current || defaultReviewTarget(stages, selectedStage?.id ?? null, "cancelled"));
    }
  };

  if (!selectedCompanyId) {
    return <EmptyState icon={Hexagon} message="Select a company to edit pipeline settings." />;
  }

  if (!pipelineId) {
    return <EmptyState icon={Hexagon} message="No pipeline selected." />;
  }

  if (pipelineQuery.isLoading) {
    return <PageSkeleton variant="list" />;
  }

  if (pipelineQuery.error) {
    return <p className="text-sm text-destructive">{pipelineQuery.error.message}</p>;
  }

  if (!pipeline) {
    return <EmptyState icon={Hexagon} message="Pipeline not found." />;
  }

  const isArchived = Boolean(pipeline.archivedAt);
  const archiveEnabled = archiveConfirmation === pipeline.name && !archivePipeline.isPending;
  const reviewTargetsMissing = stageKind === "review" && (!approveTarget || !rejectTarget);
  const otherStages = stages.filter((stage) => stage.id !== selectedStage?.id);

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <Link to={`/pipelines/${pipeline.id}`} className="text-sm text-muted-foreground hover:text-foreground">
            Back to board
          </Link>
          <h1 className="mt-2 text-2xl font-semibold tracking-normal text-foreground">{pipeline.name} settings</h1>
          {pipeline.description ? <p className="mt-1 text-sm text-muted-foreground">{pipeline.description}</p> : null}
        </div>
      </div>

      <div className="flex border-b border-border" role="tablist" aria-label="Pipeline settings tabs">
        {TAB_LABELS.map((tab) => (
          <button
            key={tab.id}
            type="button"
            role="tab"
            data-tab-value={tab.id}
            aria-selected={activeTab === tab.id}
            className={cn(
              "border-b-2 px-4 py-2 text-sm font-semibold",
              activeTab === tab.id
                ? "border-foreground text-foreground"
                : "border-transparent text-muted-foreground hover:text-foreground",
            )}
            onClick={() => setActiveTab(tab.id)}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {activeTab === "stages" ? (
        <div className="space-y-6">
          {stages.length === 0 ? (
            <EmptyState
              icon={GitBranch}
              message="No stages configured."
              action="Add first stage"
              onAction={() => addStage.mutate(null)}
            />
          ) : (
            <div className="overflow-x-auto border-y border-border py-4">
              <div className="flex min-w-max items-center gap-2">
                {stages.map((stage, index) => (
                  <div key={stage.id} className="flex items-center gap-2">
                    <button
                      type="button"
                      className={cn(
                        "min-h-20 w-48 rounded-md border px-3 py-2 text-left text-sm transition-colors",
                        selectedStage?.id === stage.id
                          ? "border-foreground bg-accent/50"
                          : "border-border hover:bg-accent/40",
                      )}
                      onClick={() => setSelectedStageId(stage.id)}
                    >
                      <span className="block font-semibold text-foreground">{stage.name}</span>
                      <span className="mt-1 block text-xs text-muted-foreground">Step {index + 1}</span>
                      {stageNewEntriesDisabled(stage) ? (
                        <span className="mt-2 inline-flex items-center gap-1 text-xs font-medium text-amber-700 dark:text-amber-300">
                          <AlertTriangle className="h-3 w-3" />
                          New entries paused
                        </span>
                      ) : null}
                    </button>
                    <button
                      type="button"
                      aria-label={`Insert stage after ${stage.name}`}
                      className="inline-flex h-8 w-8 items-center justify-center rounded-md border border-dashed border-border text-muted-foreground hover:border-foreground hover:text-foreground"
                      onClick={() => addStage.mutate(stage)}
                      disabled={addStage.isPending}
                    >
                      <Plus className="h-4 w-4" />
                    </button>
                    {index === stages.length - 1 ? null : (
                      <span className="h-px w-8 bg-border" aria-hidden="true" />
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}

          {selectedStage ? (
            <form
              className="space-y-5"
              onSubmit={(event: FormEvent<HTMLFormElement>) => {
                event.preventDefault();
                saveStage.mutate();
              }}
            >
              <Section title="Basics">
                <div className="grid gap-3 md:grid-cols-[minmax(0,1fr)_220px]">
                  <label className="block space-y-1.5 text-sm font-medium">
                    <span>Name</span>
                    <Input value={stageName} onChange={(event) => setStageName(event.target.value)} required />
                  </label>
                  <label className="block space-y-1.5 text-sm font-medium">
                    <span>Kind</span>
                    <select
                      value={stageKind}
                      onChange={(event) => setStageKindWithDefaults(event.target.value)}
                      className="h-10 w-full rounded-md border border-input bg-background px-3 text-sm"
                    >
                      <option value="open">Open</option>
                      <option value="working">Working</option>
                      <option value="review">Review</option>
                      <option value="done">Done</option>
                      <option value="cancelled">Cancelled</option>
                    </select>
                  </label>
                </div>
              </Section>

              <Section title="Disable">
                <div className="flex items-center justify-between gap-4">
                  <div>
                    <div className="text-sm font-medium">Block new entry</div>
                    <p className="mt-1 text-sm text-muted-foreground">
                      Nothing new can move into this stage. Existing items stay visible on the board.
                    </p>
                  </div>
                  <ToggleSwitch checked={newEntriesDisabled} onCheckedChange={setNewEntriesDisabled} />
                </div>
                {newEntriesDisabled ? (
                  <label className="block space-y-1.5 text-sm font-medium">
                    <span>Reason</span>
                    <Textarea
                      value={disableReason}
                      onChange={(event) => setDisableReason(event.target.value)}
                      rows={2}
                    />
                  </label>
                ) : null}
              </Section>

              <Section title="Approval">
                <div className="flex items-center justify-between gap-4">
                  <div>
                    <div className="text-sm font-medium">Require approval</div>
                    <p className="mt-1 text-sm text-muted-foreground">
                      Items need a sign-off before they can leave this stage.
                    </p>
                  </div>
                  <ToggleSwitch checked={approvalRequired} onCheckedChange={setApprovalRequired} />
                </div>
                {approvalRequired ? (
                  <label className="block max-w-md space-y-1.5 text-sm font-medium">
                    <span>Approver</span>
                    <select
                      aria-label="Approval picker"
                      value={selectedApproval}
                      onChange={(event) => setSelectedApproval(event.target.value)}
                      className="h-10 w-full rounded-md border border-input bg-background px-3 text-sm"
                    >
                      <option value="any_human">Any human</option>
                      <optgroup label="People">
                        {(usersQuery.data?.users ?? []).map((user) => (
                          <option key={user.principalId} value={`user:${user.principalId}`}>
                            {humanLabel(user)}
                          </option>
                        ))}
                      </optgroup>
                      <optgroup label="Agents">
                        {(agentsQuery.data ?? []).map((agent) => (
                          <option key={agent.id} value={`agent:${agent.id}`}>
                            {agentLabel(agent)}
                          </option>
                        ))}
                      </optgroup>
                    </select>
                  </label>
                ) : null}
              </Section>

              {stageKind === "review" ? (
                <Section title="Review outcomes">
                  <div className="grid gap-3 sm:grid-cols-2">
                    <label className="block space-y-1.5 text-sm font-medium">
                      <span>Approved items move to</span>
                      <select
                        aria-label="Approved items move to"
                        value={approveTarget}
                        onChange={(event) => setApproveTarget(event.target.value)}
                        className="h-10 w-full rounded-md border border-input bg-background px-3 text-sm"
                      >
                        <option value="">Choose a stage</option>
                        {otherStages.map((stage) => (
                          <option key={stage.id} value={stage.key}>{stage.name}</option>
                        ))}
                      </select>
                    </label>
                    <label className="block space-y-1.5 text-sm font-medium">
                      <span>Declined items move to</span>
                      <select
                        aria-label="Declined items move to"
                        value={rejectTarget}
                        onChange={(event) => setRejectTarget(event.target.value)}
                        className="h-10 w-full rounded-md border border-input bg-background px-3 text-sm"
                      >
                        <option value="">Choose a stage</option>
                        {otherStages.map((stage) => (
                          <option key={stage.id} value={stage.key}>{stage.name}</option>
                        ))}
                      </select>
                    </label>
                    <label className="block space-y-1.5 text-sm font-medium">
                      <span>Items needing changes move to</span>
                      <select
                        aria-label="Items needing changes move to"
                        value={requestChangesTarget}
                        onChange={(event) => setRequestChangesTarget(event.target.value)}
                        className="h-10 w-full rounded-md border border-input bg-background px-3 text-sm"
                      >
                        <option value="">Stay in review</option>
                        {otherStages.map((stage) => (
                          <option key={stage.id} value={stage.key}>{stage.name}</option>
                        ))}
                      </select>
                    </label>
                    <div className="flex items-center justify-between gap-4 pt-1">
                      <div className="text-sm font-medium">Ask for a note when declining</div>
                      <ToggleSwitch checked={requireRejectReason} onCheckedChange={setRequireRejectReason} />
                    </div>
                  </div>
                  {reviewTargetsMissing ? (
                    <p className="text-sm text-muted-foreground">
                      Pick where approved and declined items should go before saving.
                    </p>
                  ) : null}
                </Section>
              ) : null}

              <Section title="What happens here">
                <Textarea
                  value={whatHappensHere}
                  onChange={(event) => setWhatHappensHere(event.target.value)}
                  rows={4}
                  placeholder="Describe the work that should happen in this stage."
                />
              </Section>

              <Section title="Routine variables">
                <div className="space-y-3">
                  {variables.map((variable) => (
                    <div key={variable.id} className="grid gap-2 border-b border-border pb-3 md:grid-cols-[160px_1fr_140px_1fr_auto]">
                      <Input
                        aria-label="Variable key"
                        value={variable.key}
                        onChange={(event) => updateVariable(variable.id, { key: event.target.value })}
                        placeholder="field_key"
                      />
                      <Input
                        aria-label="Variable label"
                        value={variable.label}
                        onChange={(event) => updateVariable(variable.id, { label: event.target.value })}
                        placeholder="Field label"
                      />
                      <select
                        aria-label="Variable type"
                        value={variable.type}
                        onChange={(event) => updateVariable(variable.id, { type: event.target.value as VariableType })}
                        className="h-10 rounded-md border border-input bg-background px-3 text-sm"
                      >
                        <option value="text">Text</option>
                        <option value="multiline">Multiline</option>
                        <option value="select">Select</option>
                      </select>
                      <Input
                        aria-label="Variable options"
                        value={variable.optionsText}
                        onChange={(event) => updateVariable(variable.id, { optionsText: event.target.value })}
                        placeholder="Options, comma separated"
                        disabled={variable.type !== "select"}
                      />
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon-sm"
                        aria-label={`Remove ${variable.label || variable.key}`}
                        onClick={() => setVariables((current) => current.filter((item) => item.id !== variable.id))}
                      >
                        <Trash2 className="h-4 w-4" />
                      </Button>
                      <label className="flex items-center gap-2 text-sm text-muted-foreground md:col-span-2">
                        <input
                          type="checkbox"
                          checked={variable.required}
                          onChange={(event) => updateVariable(variable.id, { required: event.target.checked })}
                        />
                        Required
                      </label>
                      <label className="flex items-center gap-2 text-sm text-muted-foreground md:col-span-3">
                        <input
                          type="checkbox"
                          checked={variable.showInAddForm}
                          onChange={(event) => updateVariable(variable.id, { showInAddForm: event.target.checked })}
                        />
                        Show in Add-items form
                      </label>
                    </div>
                  ))}
                  <Button type="button" variant="outline" onClick={addVariable}>
                    <Plus className="h-4 w-4" />
                    Add variable
                  </Button>
                </div>
              </Section>

              <Section title="Connections">
                <div className="grid gap-2 sm:grid-cols-2">
                  {otherStages.map((stage) => (
                    <label key={stage.id} className="flex items-center gap-2 rounded-md border border-border px-3 py-2 text-sm">
                      <input
                        type="checkbox"
                        checked={transitionTargets.has(stage.id)}
                        onChange={(event) => {
                          setTransitionTargets((current) => {
                            const next = new Set(current);
                            if (event.target.checked) next.add(stage.id);
                            else next.delete(stage.id);
                            return next;
                          });
                        }}
                      />
                      {selectedStage.name} can move to {stage.name}
                    </label>
                  ))}
                </div>
              </Section>

              <Section title="Advanced identifiers">
                <dl className="grid gap-2 text-sm sm:grid-cols-2">
                  <div>
                    <dt className="text-muted-foreground">Pipeline ID</dt>
                    <dd className="font-mono text-xs">{pipeline.id}</dd>
                  </div>
                  <div>
                    <dt className="text-muted-foreground">Stage ID</dt>
                    <dd className="font-mono text-xs">{selectedStage.id}</dd>
                  </div>
                  <div>
                    <dt className="text-muted-foreground">Position</dt>
                    <dd>{selectedStage.position}</dd>
                  </div>
                  <div>
                    <dt className="text-muted-foreground">Kind</dt>
                    <dd>{selectedStage.kind}</dd>
                  </div>
                </dl>
              </Section>

              {saveStage.error ? <p className="text-sm text-destructive">{saveStage.error.message}</p> : null}
              <Button type="submit" disabled={saveStage.isPending || !stageName.trim() || reviewTargetsMissing}>
                {saveStage.isPending ? <Check className="h-4 w-4" /> : <Save className="h-4 w-4" />}
                {saveStage.isPending ? "Saving..." : "Save stage"}
              </Button>
            </form>
          ) : null}
        </div>
      ) : null}

      {activeTab === "guidance" ? (
        <form
          className="max-w-3xl space-y-4"
          onSubmit={(event) => {
            event.preventDefault();
            saveGuidance.mutate();
          }}
        >
          <div>
            <h2 className="text-lg font-semibold text-foreground">Pipeline guidance</h2>
            <p className="mt-1 text-sm text-muted-foreground">
              Plain-language instructions agents and operators can use when handling this pipeline.
            </p>
          </div>
          <Textarea
            value={guidanceBody}
            onChange={(event) => setGuidanceBody(event.target.value)}
            rows={12}
            placeholder="Write guidance for how work should enter, move through, and leave this pipeline."
          />
          {saveGuidance.error ? <p className="text-sm text-destructive">{saveGuidance.error.message}</p> : null}
          <Button type="submit" disabled={saveGuidance.isPending || !guidanceBody.trim()}>
            <Save className="h-4 w-4" />
            {saveGuidance.isPending ? "Saving..." : "Save guidance"}
          </Button>
        </form>
      ) : null}

      {activeTab === "advanced" ? (
        <div className="max-w-2xl space-y-6">
          <form
            className="space-y-4"
            onSubmit={(event) => {
              event.preventDefault();
              savePipelineDetails.mutate();
            }}
          >
            <div>
              <h2 className="text-lg font-semibold text-foreground">Details</h2>
              <p className="mt-1 text-sm text-muted-foreground">
                Rename the pipeline or update its description.
              </p>
            </div>
            <label className="block space-y-1.5 text-sm font-medium">
              <span>Name</span>
              <Input
                aria-label="Pipeline name"
                value={pipelineName}
                onChange={(event) => setPipelineName(event.target.value)}
                required
              />
            </label>
            <label className="block space-y-1.5 text-sm font-medium">
              <span>Description</span>
              <Textarea
                value={pipelineDescription}
                onChange={(event) => setPipelineDescription(event.target.value)}
                rows={3}
              />
            </label>
            {savePipelineDetails.error ? (
              <p className="text-sm text-destructive">{savePipelineDetails.error.message}</p>
            ) : null}
            <Button type="submit" disabled={savePipelineDetails.isPending || !pipelineName.trim()}>
              <Save className="h-4 w-4" />
              {savePipelineDetails.isPending ? "Saving..." : "Save details"}
            </Button>
          </form>

          <div className="rounded-md border border-destructive/30 p-4">
            <div className="flex items-start gap-3">
              <AlertTriangle className="mt-0.5 h-5 w-5 text-destructive" />
              <div className="min-w-0 flex-1 space-y-3">
                <div>
                  <h2 className="text-lg font-semibold text-foreground">Danger zone</h2>
                  <p className="mt-1 text-sm text-muted-foreground">
                    {isArchived
                      ? "This pipeline is archived. Restore it to make it active again."
                      : "Archiving hides this pipeline from everyday views. Its stages, guidance, and items are kept and can be restored later."}
                  </p>
                </div>
                {isArchived ? (
                  <Button
                    type="button"
                    variant="outline"
                    disabled={archivePipeline.isPending}
                    onClick={() => archivePipeline.mutate(false)}
                  >
                    <Archive className="h-4 w-4" />
                    {archivePipeline.isPending ? "Restoring..." : "Restore pipeline"}
                  </Button>
                ) : (
                  <>
                    <label className="block space-y-1.5 text-sm font-medium">
                      <span>Type {pipeline.name} to confirm</span>
                      <Input
                        aria-label="Archive confirmation"
                        value={archiveConfirmation}
                        onChange={(event) => setArchiveConfirmation(event.target.value)}
                        autoComplete="off"
                      />
                    </label>
                    {archivePipeline.error ? (
                      <p className="text-sm text-destructive">{archivePipeline.error.message}</p>
                    ) : null}
                    <Button
                      type="button"
                      variant="destructive"
                      disabled={!archiveEnabled}
                      onClick={() => archivePipeline.mutate(true)}
                    >
                      <Archive className="h-4 w-4" />
                      {archivePipeline.isPending ? "Archiving..." : "Archive pipeline"}
                    </Button>
                  </>
                )}
              </div>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
