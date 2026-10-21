import "../../../../test/setup";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ComposeApplicationsPanel } from "./ComposeApplicationsPanel";
import { useComposeApplications } from "./useComposeApplications";
import type { ComposeApplicationsData } from "./useComposeApplications";
import { createVpsComposeApplication } from "../../../../lib/compose-applications";
import type { ComposeAppSummary, ComposeCapability } from "../../../../lib/compose-applications";
import { MemoryRouter } from "react-router-dom";

vi.mock("./ComposeCapabilityNotice", () => ({
  ComposeCapabilityNotice: () => null,
  ComposeInventoryIncompleteNote: () => null,
}));
vi.mock("./ComposeApplicationDetail", () => ({
  ComposeApplicationDetail: () => <div>detail-view</div>,
}));
vi.mock("./useComposeApplications", () => ({
  useComposeApplications: vi.fn(),
}));
vi.mock("../../../../lib/compose-applications", () => ({
  createVpsComposeApplication: vi.fn(),
  vpsComposeModeLabel: (mode: string) => mode,
  composeErrorCode: () => undefined,
  composeOperationIsActive: () => false,
}));

afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});

function item(appId: string, mode: ComposeAppSummary["mode"]): ComposeAppSummary {
  return {
    appId,
    displayName: appId,
    projectName: appId,
    mode,
    observed: { services: [] },
  };
}

const capability: ComposeCapability = {
  supported: true,
  runtime: { dockerPresent: true },
  agent: {},
  inventory: { completeness: true },
  admission: { ready: true, reasons: [] },
  demoDisabled: false,
};

function hookData(
  applications: ComposeAppSummary[],
  overrides: { refresh?: () => void } = {},
): {
  capability: ComposeCapability | null;
  applications: ComposeAppSummary[];
  loading: boolean;
  loadingMore: boolean;
  nextCursor: string | undefined;
  error: string | null;
  loadMoreError: string | null;
  refresh: () => void;
  loadMore: () => Promise<void>;
} {
  return {
    capability,
    applications,
    loading: false,
    loadingMore: false,
    nextCursor: undefined,
    error: null,
    loadMoreError: null,
    refresh: () => undefined,
    loadMore: () => Promise.resolve(),
    ...overrides,
  };
}

function renderPanel() {
  return render(
    <MemoryRouter>
      <ComposeApplicationsPanel vpsId="vps-1" refreshTick={0} />
    </MemoryRouter>,
  );
}

describe("ComposeApplicationsPanel mode filter", () => {
  it("keeps the mode filter usable and restorable to All modes when the filtered result is empty", () => {
    vi.mocked(useComposeApplications).mockReturnValue(hookData([item("readonly", "detected_readonly")]));
    renderPanel();

    const select = screen.getByLabelText(/filter by management mode/i) as HTMLSelectElement;
    fireEvent.change(select, { target: { value: "external_control" } });
    expect(screen.queryByText("readonly")).toBeNull();

    fireEvent.change(select, { target: { value: "all" } });
    expect(screen.getByText("readonly")).toBeTruthy();
  });
});

describe("ComposeApplicationsPanel create flow", () => {
  it("calls refresh after a successful create so the new row appears", async () => {
    const refresh = vi.fn();
    vi.mocked(useComposeApplications).mockReturnValue(
      hookData([item("created-app", "managed")], { refresh }),
    );
    const create = vi.mocked(createVpsComposeApplication);
    create.mockResolvedValue(item("created-app", "managed"));
    renderPanel();
    fireEvent.click(screen.getByRole("button", { name: /new application/i }));
    fireEvent.change(await screen.findByLabelText(/display name/i), { target: { value: "Created stack" } });
    fireEvent.click(screen.getByRole("button", { name: /^create$/i }));

    await waitFor(() => expect(create).toHaveBeenCalled());
    await waitFor(() => expect(refresh).toHaveBeenCalled());
  });
});
