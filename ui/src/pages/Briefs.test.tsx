// @vitest-environment jsdom

import type { ReactNode } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { Briefs } from "./Briefs";

const companyState = vi.hoisted(() => ({
  selectedCompanyId: "company-1" as string | null,
  companies: [{ id: "company-1", name: "Paperclip", issuePrefix: "PAP" }],
}));

const breadcrumbState = vi.hoisted(() => ({
  setBreadcrumbs: vi.fn(),
}));

const briefsApiMock = vi.hoisted(() => ({
  overview: vi.fn(),
}));

vi.mock("@/context/CompanyContext", () => ({
  useCompany: () => companyState,
}));

vi.mock("@/context/BreadcrumbContext", () => ({
  useBreadcrumbs: () => breadcrumbState,
}));

vi.mock("@/api/briefs", () => ({
  briefsApi: briefsApiMock,
}));

vi.mock("@/components/BuiltInAgentGate", () => ({
  BuiltInAgentGate: ({
    agentKey,
    companyId,
    featureLabel,
    children,
  }: {
    agentKey: string;
    companyId: string | null | undefined;
    featureLabel?: string;
    children: ReactNode;
  }) => (
    <div
      data-testid="built-in-gate"
      data-agent-key={agentKey}
      data-company-id={companyId ?? ""}
      data-feature-label={featureLabel ?? ""}
    >
      {children}
    </div>
  ),
}));

async function flushReact() {
  for (let index = 0; index < 5; index += 1) {
    await Promise.resolve();
    await new Promise((resolve) => window.setTimeout(resolve, 0));
  }
  flushSync(() => {});
}

function renderBriefs(container: HTMLDivElement) {
  const root = createRoot(container);
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });

  flushSync(() => {
    root.render(
      <QueryClientProvider client={queryClient}>
        <Briefs />
      </QueryClientProvider>,
    );
  });

  return root;
}

describe("Briefs page", () => {
  let container: HTMLDivElement;
  let root: Root | null = null;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    companyState.selectedCompanyId = "company-1";
    companyState.companies = [{ id: "company-1", name: "Paperclip", issuePrefix: "PAP" }];
    briefsApiMock.overview.mockReset();
    breadcrumbState.setBreadcrumbs.mockReset();
    briefsApiMock.overview.mockResolvedValue({
      featureKey: "briefs",
      status: "ready",
      generatedAt: "2026-07-07T22:45:00.000Z",
      agent: {
        id: "agent-1",
        name: "Briefs Agent",
        status: "idle",
        adapterType: "codex_local",
      },
      warning: null,
      summaryItems: [
        { label: "Agent", value: "Briefs Agent", detail: "idle" },
        { label: "Adapter", value: "codex_local" },
        { label: "Last checked", value: "2026-07-07T22:45:00.000Z" },
      ],
    });
  });

  afterEach(() => {
    flushSync(() => {
      root?.unmount();
    });
    root = null;
    container.remove();
  });

  it("wraps the live surface in the Briefs built-in agent gate", async () => {
    root = renderBriefs(container);
    await flushReact();

    const gate = container.querySelector('[data-testid="built-in-gate"]');
    expect(gate?.getAttribute("data-agent-key")).toBe("briefs");
    expect(gate?.getAttribute("data-company-id")).toBe("company-1");
    expect(gate?.getAttribute("data-feature-label")).toBe("Briefs");
    expect(briefsApiMock.overview).toHaveBeenCalledWith("company-1");
    expect(container.textContent).toContain("Briefs Agent");
    expect(container.textContent).toContain("No briefs yet");
    expect(breadcrumbState.setBreadcrumbs).toHaveBeenCalledWith([{ label: "Briefs" }]);
  });

  it("asks for a company before loading the Briefs surface", async () => {
    companyState.selectedCompanyId = null;
    root = renderBriefs(container);
    await flushReact();

    expect(container.textContent).toContain("Select a company to view briefs.");
    expect(container.querySelector('[data-testid="built-in-gate"]')).toBeNull();
    expect(briefsApiMock.overview).not.toHaveBeenCalled();
  });
});
