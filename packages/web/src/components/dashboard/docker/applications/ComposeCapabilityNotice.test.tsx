import "../../../../test/setup";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ComposeCapabilityNotice } from "./ComposeCapabilityNotice";
import * as api from "../../../../lib/compose-applications";
import type { ComposeCapability, ComposeOperation } from "../../../../lib/compose-applications";

vi.mock("../../../../lib/compose-applications", () => ({
  requestComposeRuntimePreparation: vi.fn(),
  getVpsComposeOperation: vi.fn(),
  // The notice gates its polling on the shared active-status predicate, so the
  // double must provide the real behavior rather than inherit `undefined`.
  composeOperationIsActive: (status: string) =>
    ["prepared", "claimed", "preflighting", "pulling", "applying", "observing"].includes(status),
}));

describe("ComposeCapabilityNotice runtime preparation", () => {
  const onRetry = vi.fn();

  beforeEach(() => {
    onRetry.mockReset();
  });

  afterEach(() => {
    cleanup();
    vi.resetAllMocks();
  });

  it("does not offer host runtime preparation before an inventory scan arrives", () => {
    render(
      <ComposeCapabilityNotice
        vpsId="vps-1"
        capability={{
          supported: false,
          demoDisabled: false,
          reason: "compose_runtime_unverified",
          runtime: { dockerPresent: false },
          agent: {},
          inventory: { completeness: false },
          admission: { ready: false, reasons: ["fresh_connected_inventory_required"] },
        }}
        loading={false}
        error={null}
        onRetry={onRetry}
      />,
    );

    expect(screen.getByRole("status").textContent).toMatch(/availability are unverified/i);
    expect(screen.queryByRole("button", { name: "Prepare Docker Compose runtime" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Refresh capability" }));
    expect(onRetry).toHaveBeenCalledTimes(1);
    expect(api.requestComposeRuntimePreparation).not.toHaveBeenCalled();
  });

  it("shows runtime preparation button when compose v2 plugin is missing", async () => {
    const capability: ComposeCapability = {
      supported: false,
      reason: "Compose v2 plugin is not installed on the remote host",
      runtime: { dockerPresent: true, composeVersion: undefined },
      agent: {},
      inventory: { ageSeconds: 5, completeness: true },
      admission: { ready: false, reasons: ["Compose missing"] },
      demoDisabled: false,
    };

    render(
      <ComposeCapabilityNotice
        vpsId="vps-1"
        capability={capability}
        loading={false}
        error={null}
        onRetry={onRetry}
      />,
    );

    expect(screen.getByText(/Docker Compose runtime preparation/i)).toBeTruthy();
    const prepBtn = screen.getByRole("button", { name: "Prepare Docker Compose runtime" });
    expect(prepBtn).toBeTruthy();

    fireEvent.click(prepBtn);

    // Confirmation dialog: title repeats the trigger label, so query the dialog.
    const dialog = await screen.findByRole("alertdialog");
    expect(dialog).toBeTruthy();
    expect(dialog.textContent).toMatch(/Prepare Docker Compose runtime/i);
    expect(dialog.textContent).toMatch(/isolated FlexServer directory/i);
    expect(api.requestComposeRuntimePreparation).not.toHaveBeenCalled();
  });

  it("displays success message when existing runtime is compatible and no install is needed", async () => {
    const capability: ComposeCapability = {
      supported: false,
      reason: "Compose plugin missing",
      runtime: { dockerPresent: true },
      agent: {},
      inventory: { ageSeconds: 5, completeness: true },
      admission: { ready: false, reasons: [] },
      demoDisabled: false,
    };

    const mockOp: ComposeOperation = {
      id: "op-prep-1",
      vpsId: "vps-1",
      appId: "runtime",
      kind: "runtime_prep",
      status: "succeeded",
      createdAt: "2026-10-20T10:00:00.000Z",
      result: { outcome: "verified_existing", installPerformed: false },
    };

    vi.mocked(api.requestComposeRuntimePreparation).mockResolvedValue(mockOp);

    render(
      <ComposeCapabilityNotice
        vpsId="vps-1"
        capability={capability}
        loading={false}
        error={null}
        onRetry={onRetry}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Prepare Docker Compose runtime" }));
    fireEvent.click(await screen.findByRole("button", { name: "Confirm preparation" }));

    await waitFor(() => {
      expect(
        screen.getByText(/Host already has a trusted compatible Compose runtime; no installation was needed/i),
      ).toBeTruthy();
      expect(onRetry).toHaveBeenCalled();
    });
  });

  it("displays guidance when Docker CLI is missing on the host", async () => {
    const capability: ComposeCapability = {
      supported: false,
      reason: "Docker missing",
      runtime: { dockerPresent: false },
      agent: {},
      inventory: { ageSeconds: 5, completeness: true },
      admission: { ready: false, reasons: [] },
      demoDisabled: false,
    };

    const mockOp: ComposeOperation = {
      id: "op-prep-err",
      vpsId: "vps-1",
      appId: "runtime",
      kind: "runtime_prep",
      status: "failed",
      createdAt: "2026-10-20T10:00:00.000Z",
      error: {
        code: "docker_cli_missing",
        message: "Docker CLI missing",
      },
    };

    vi.mocked(api.requestComposeRuntimePreparation).mockResolvedValue(mockOp);

    render(
      <ComposeCapabilityNotice
        vpsId="vps-1"
        capability={capability}
        loading={false}
        error={null}
        onRetry={onRetry}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Prepare Docker Compose runtime" }));
    fireEvent.click(await screen.findByRole("button", { name: "Confirm preparation" }));

    await waitFor(() => {
      expect(
        screen.getByText(/Docker CLI is missing on the host\. Please install docker-ce-cli/i),
      ).toBeTruthy();
    });
  });
});
