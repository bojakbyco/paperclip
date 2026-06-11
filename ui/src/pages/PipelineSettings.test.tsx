// @vitest-environment jsdom

import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Agent } from "@paperclipai/shared";
import type { CompanyUserDirectoryResponse } from "../api/access";
import type { PipelineDetail, PipelineDocumentPayload } from "../api/pipelines";
import { agentsApi } from "../api/agents";
import { accessApi } from "../api/access";
import { pipelinesApi } from "../api/pipelines";
import { PipelineSettings } from "./PipelineSettings";

vi.mock("@/lib/router", () => ({
  Link: ({
    children,
    to,
    ...props
  }: React.AnchorHTMLAttributes<HTMLAnchorElement> & { to: string }) => (
    <a href={to} {...props}>{children}</a>
  ),
  useNavigate: () => vi.fn(),
  useParams: () => ({ pipelineId: "pipeline-1" }),
}));

vi.mock("../context/CompanyContext", () => ({
  useCompany: () => ({ selectedCompanyId: "company-1" }),
}));

vi.mock("../context/BreadcrumbContext", () => ({
  useBreadcrumbs: () => ({ setBreadcrumbs: vi.fn() }),
}));

vi.mock("../context/ToastContext", () => ({
  useToastActions: () => ({ pushToast: vi.fn() }),
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

function makePipeline(): PipelineDetail {
  return {
    id: "pipeline-1",
    companyId: "company-1",
    key: "content_pipeline",
    name: "Content pipeline",
    description: "Publish useful work",
    projectId: null,
    enforceTransitions: false,
    archivedAt: null,
    stageCount: 2,
    openCaseCount: 0,
    createdAt: "2026-06-01T00:00:00.000Z",
    updatedAt: "2026-06-01T00:00:00.000Z",
    stages: [
      {
        id: "stage-1",
        pipelineId: "pipeline-1",
        key: "intake",
        name: "Intake",
        kind: "open",
        position: 100,
        config: {
          variables: [
            {
              key: "customer",
              label: "Customer",
              type: "text",
              options: [],
              required: true,
              showInAddForm: true,
            },
          ],
          disabled: false,
          requireApproval: false,
          approver: { kind: "any_human" },
          whatHappensHere: "Collect requests.",
        },
      },
      {
        id: "stage-2",
        pipelineId: "pipeline-1",
        key: "review",
        name: "Review",
        kind: "review",
        position: 200,
        config: {
          variables: [],
          approveToStageKey: "intake",
          rejectToStageKey: "intake",
        },
      },
    ],
    transitions: [{ fromStageId: "stage-1", toStageId: "stage-2" }],
    documentKeys: [{ key: "guidance", documentId: "doc-1" }],
  };
}

function makeGuidanceDocument(): PipelineDocumentPayload {
  return {
    link: { key: "guidance", documentId: "doc-1" },
    document: { id: "doc-1", title: "Pipeline guidance", latestBody: "Be clear." },
    revision: { body: "Be clear.", title: "Pipeline guidance" },
  };
}

function renderSettings() {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });

  flushSync(() => {
    root.render(
      <QueryClientProvider client={queryClient}>
        <PipelineSettings />
      </QueryClientProvider>,
    );
  });

  return { container, root, queryClient };
}

async function flushQueries() {
  await Promise.resolve();
  await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
}

describe("PipelineSettings", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
    vi.spyOn(pipelinesApi, "get").mockResolvedValue(makePipeline());
    vi.spyOn(pipelinesApi, "updateStage").mockResolvedValue(makePipeline().stages[0]!);
    vi.spyOn(pipelinesApi, "setTransitions").mockResolvedValue({ transitions: [] });
    vi.spyOn(pipelinesApi, "createStage").mockResolvedValue({
      id: "stage-3",
      pipelineId: "pipeline-1",
      key: "new_stage",
      name: "New stage",
      kind: "working",
      position: 101,
      config: { variables: [] },
    });
    vi.spyOn(pipelinesApi, "getDocument").mockResolvedValue(makeGuidanceDocument());
    vi.spyOn(pipelinesApi, "upsertDocument").mockResolvedValue({
      document: makeGuidanceDocument().document,
      revision: { body: "Updated.", title: "Pipeline guidance" },
    });
    vi.spyOn(pipelinesApi, "update").mockResolvedValue(makePipeline());
    vi.spyOn(agentsApi, "list").mockResolvedValue([
      { id: "agent-1", name: "QA Agent", role: "QA", status: "active" } as unknown as Agent,
    ]);
    vi.spyOn(accessApi, "listUserDirectory").mockResolvedValue({
      users: [
        {
          principalId: "user-1",
          status: "active",
          user: { id: "user-1", name: "Ada Human", email: "ada@example.com", image: null },
        },
      ],
    } as unknown as CompanyUserDirectoryResponse);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    document.body.innerHTML = "";
  });

  it("renders only Stages, Guidance, and Advanced top-level tabs", async () => {
    const { container, root, queryClient } = renderSettings();
    await flushQueries();

    const tabLabels = Array.from(container.querySelectorAll("[data-tab-value]")).map((tab) => tab.textContent);
    expect(tabLabels).toEqual(["Stages", "Guidance", "Advanced"]);
    expect(container.textContent).not.toContain("Automation");

    flushSync(() => {
      root.unmount();
    });
    queryClient.clear();
  });

  it("renders selected stage sections in the required order", async () => {
    const { container, root, queryClient } = renderSettings();
    await flushQueries();

    const expected = [
      "Basics",
      "Disable",
      "Approval",
      "What happens here",
      "Routine variables",
      "Connections",
      "Advanced identifiers",
    ];
    const headings = Array.from(container.querySelectorAll("h2"))
      .map((heading) => heading.textContent ?? "")
      .filter((heading) => expected.includes(heading));
    expect(headings).toEqual(expected);

    flushSync(() => {
      root.unmount();
    });
    queryClient.clear();
  });

  it("hides the approval picker until approval is required", async () => {
    const { container, root, queryClient } = renderSettings();
    await flushQueries();

    expect(container.querySelector('[aria-label="Approval picker"]')).toBeNull();
    const switches = Array.from(container.querySelectorAll('[role="switch"]')) as HTMLButtonElement[];
    expect(switches.length).toBeGreaterThanOrEqual(2);

    flushSync(() => {
      switches[1]!.click();
    });

    const picker = container.querySelector<HTMLSelectElement>('[aria-label="Approval picker"]');
    expect(picker).not.toBeNull();
    const options = Array.from(picker!.querySelectorAll("option")).map((option) => option.textContent);
    expect(options).toContain("Any human");
    expect(options).toContain("Ada Human");
    expect(options).toContain("QA Agent");

    flushSync(() => {
      root.unmount();
    });
    queryClient.clear();
  });

  it("gates archiving behind the pipeline name", async () => {
    const { container, root, queryClient } = renderSettings();
    await flushQueries();

    const advancedTab = container.querySelector<HTMLButtonElement>('[data-tab-value="advanced"]')!;
    flushSync(() => {
      advancedTab.click();
    });

    const archiveButton = Array.from(container.querySelectorAll("button")).find((button) =>
      button.textContent?.includes("Archive pipeline"),
    ) as HTMLButtonElement | undefined;
    expect(archiveButton?.disabled).toBe(true);

    const input = container.querySelector<HTMLInputElement>('[aria-label="Archive confirmation"]')!;
    flushSync(() => {
      const valueSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")?.set;
      valueSetter?.call(input, "Content pipeline");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });

    expect(archiveButton?.disabled).toBe(false);

    flushSync(() => {
      root.unmount();
    });
    queryClient.clear();
  });
});
