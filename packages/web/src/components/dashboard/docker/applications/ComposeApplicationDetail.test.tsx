import "../../../../test/setup";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ComposeApplicationDetail } from "./ComposeApplicationDetail";
import { MemoryRouter } from "react-router-dom";
import * as api from "../../../../lib/compose-applications";
import type {
  ComposeAppDetail,
  ComposeOperation,
  ComposeRevisionMeta,
  ComposeSecretMeta,
  ComposeRegistryCredential,
  ComposePreview,
  ComposeAdoptionPreview,
} from "../../../../lib/compose-applications";

vi.mock("../../../../lib/compose-applications", () => ({
  vpsComposeModeLabel: (mode: string) => {
    switch (mode) {
      case "detected_readonly": return "Detected (read-only)";
      case "external_control": return "External stack control";
      case "managed": return "Managed";
      case "unmanaged": return "Unmanaged";
      default: return "Unknown mode";
    }
  },
  composeOperationIsActive: (status: string) =>
    ["prepared", "claimed", "preflighting", "pulling", "applying", "observing"].includes(status),
  composeFinding: (finding: any) =>
    typeof finding === "string"
      ? { field: "", reason: finding, paramPath: [] }
      : { field: finding?.field || "", reason: finding?.reason || "", paramPath: finding?.paramPath || [] },
  composeFindingKey: (finding: any) =>
    (finding?.paramPath?.join(".") || finding?.field || "") + ":" + (finding?.reason || ""),
  COMPOSE_STALE_PREVIEW_ERROR_CODES: [
    "stale_preview",
    "preview_expired",
    "stale_revision",
    "drift_detected",
    "observed_state_changed",
  ],
  detectWildcardPortBindings: (yaml: string) => {
    if (yaml && yaml.includes("0.0.0.0:")) {
      return ["Port exposure 0.0.0.0:8080: bound to wildcard 0.0.0.0 or all host interfaces."];
    }
    return [];
  },
  loadComposeDraft: (vpsId: string, appId: string) => {
    try {
      const raw = sessionStorage.getItem(`flexserver_compose_draft_${vpsId}_${appId}`);
      return raw ? JSON.parse(raw) : null;
    } catch {
      return null;
    }
  },
  saveComposeDraft: (vpsId: string, appId: string, draft: any) => {
    try {
      sessionStorage.setItem(
        `flexserver_compose_draft_${vpsId}_${appId}`,
        JSON.stringify({ ...draft, savedAt: new Date().toISOString() }),
      );
    } catch {}
  },
  clearComposeDraft: (vpsId: string, appId: string) => {
    try {
      sessionStorage.removeItem(`flexserver_compose_draft_${vpsId}_${appId}`);
    } catch {}
  },
  loadCachedComposeDetail: (vpsId: string, appId: string) => {
    try {
      const raw = sessionStorage.getItem(`flexserver_compose_cache_${vpsId}_${appId}`);
      return raw ? JSON.parse(raw) : null;
    } catch {
      return null;
    }
  },
  saveCachedComposeDetail: (vpsId: string, appId: string, detail: any, operations: any[]) => {
    try {
      sessionStorage.setItem(
        `flexserver_compose_cache_${vpsId}_${appId}`,
        JSON.stringify({ detail, operations, cachedAt: new Date().toISOString() }),
      );
    } catch {}
  },
  getVpsComposeApplication: vi.fn(),
  listComposeOperations: vi.fn(),
  listComposeRevisions: vi.fn(),
  listComposeSecrets: vi.fn(),
  listComposeRegistryCredentials: vi.fn(),
  createComposePreview: vi.fn(),
  getComposePreview: vi.fn(),
  confirmComposePreview: vi.fn(),
  requestComposeLifecycle: vi.fn(),
  verifyComposeSource: vi.fn(),
  adoptComposeApplication: vi.fn(),
  unmanageComposeApplication: vi.fn(),
  cancelComposeOperation: vi.fn(),
  recheckComposeOperation: vi.fn(),
  setComposeSecret: vi.fn(),
  deleteComposeSecret: vi.fn(),
  setComposeRegistryCredential: vi.fn(),
  deleteComposeRegistryCredential: vi.fn(),
  getVpsComposeOperation: vi.fn(),
  optInComposeExternalControl: vi.fn(),
  getComposeAdoptionPreview: vi.fn(),
  updateComposeApplicationReadiness: vi.fn(),
  requestComposeRuntimePreparation: vi.fn(),
}));

const mockDetail: ComposeAppDetail = {
  appId: "app-managed-1",
  displayName: "My Production Stack",
  projectName: "prod-stack",
  daemonEpoch: "epoch-12345",
  agentInstanceId: "agent-1",
  mode: "managed",
  readinessSeconds: 300,
  observed: {
    services: [
      {
        service: "web",
        kind: "longlived",
        replicas: [{ containerKey: "web-1", state: "running", health: "healthy" }],
        desiredCount: 1,
      },
      {
        service: "migrate",
        kind: "oneshot",
        replicas: [{ containerKey: "migrate-1", state: "exited" }],
        desiredCount: 0,
      },
    ],
  },
  latestRevisionSeq: 1,
  secrets: [],
};

const mockOperation: ComposeOperation = {
  id: "op-1",
  vpsId: "vps-1",
  appId: "app-managed-1",
  kind: "deploy",
  status: "succeeded",
  actor: { kind: "operator", id: "admin@example.com" },
  createdAt: "2026-10-20T10:00:00.000Z",
  mutationStarted: true,
  mutationStartedAt: "2026-10-20T10:01:00.000Z",
  revisionSeq: 1,
  approvedDigest: "sha256:abc123def4567890",
  progress: {
    seq: 1,
    items: [
      { stage: "preflight", status: "ok", at: "2026-10-20T10:00:10.000Z" },
      { stage: "apply", status: "ok", at: "2026-10-20T10:01:10.000Z" },
    ],
  },
  result: {
    outcome: "deployed",
    serviceOutcomes: [
      { service: "web", outcome: "recreated" },
      { service: "migrate", outcome: "exited_zero" },
    ],
  },
};

const mockRevision: ComposeRevisionMeta = {
  seq: 1,
  createdAt: "2026-10-20T09:00:00.000Z",
  profiles: [],
  oneShotServices: ["migrate"],
};

describe("ComposeApplicationDetail", () => {
  const onBack = vi.fn();

  beforeEach(() => {
    sessionStorage.clear();
    vi.mocked(api.getVpsComposeApplication).mockResolvedValue(mockDetail);
    vi.mocked(api.listComposeOperations).mockResolvedValue({ items: [mockOperation], nextCursor: undefined });
    vi.mocked(api.listComposeRevisions).mockResolvedValue({ items: [mockRevision] });
    vi.mocked(api.listComposeSecrets).mockResolvedValue([]);
    vi.mocked(api.listComposeRegistryCredentials).mockResolvedValue([]);
  });

  afterEach(() => {
    cleanup();
    vi.resetAllMocks();
  });

  function renderDetail(appId = "app-managed-1") {
    return render(
      <MemoryRouter>
        <ComposeApplicationDetail vpsId="vps-1" appId={appId} onBack={onBack} />
      </MemoryRouter>,
    );
  }

  it("renders merged identities correctly with observed services and container links", async () => {
    renderDetail();
    expect(await screen.findByText("My Production Stack")).toBeTruthy();
    expect(screen.getByText("Managed")).toBeTruthy();
    expect(screen.getByText("Project: prod-stack")).toBeTruthy();

    // Check services with one-shot vs long-lived indicators
    expect(screen.getByText("Long-lived service")).toBeTruthy();
    expect(screen.getByText("One-shot job")).toBeTruthy();

    // Deep link to container investigation
    const containerLinks = screen.getAllByTitle("Open container investigation");
    expect(containerLinks[0].getAttribute("href")).toContain("/vps/vps-1/docker/containers/agent-1/web-1");
  });

  it("restores draft from sessionStorage on mount and allows discarding it", async () => {
    sessionStorage.setItem(
      "flexserver_compose_draft_vps-1_app-managed-1",
      JSON.stringify({
        yaml: "services:\n  app:\n    image: test:latest",
        variableText: '{"FOO": "bar"}',
        profileText: "test-profile",
        credentialIds: "cred-1",
        oneShotServices: ["migrate"],
        secretNameToggles: [],
        savedAt: "2026-10-20T10:00:00.000Z",
      }),
    );

    renderDetail();
    expect(await screen.findByText(/Local draft restored from session storage/i)).toBeTruthy();

    const yamlArea = screen.getByLabelText("Compose YAML") as HTMLTextAreaElement;
    expect(yamlArea.value).toBe("services:\n  app:\n    image: test:latest");

    // Click discard draft
    const discardBtn = screen.getByRole("button", { name: /discard draft/i });
    fireEvent.click(discardBtn);

    expect(screen.queryByText(/Local draft restored/i)).toBeNull();
    expect(yamlArea.value).toBe("");
    expect(sessionStorage.getItem("flexserver_compose_draft_vps-1_app-managed-1")).toBeNull();
  });

  it("saves drafts into sessionStorage on editing but never saves secret values", async () => {
    renderDetail();
    await screen.findByText("My Production Stack");

    const yamlArea = screen.getByLabelText("Compose YAML");
    fireEvent.change(yamlArea, { target: { value: "services:\n  custom: 1" } });

    await waitFor(() => {
      const stored = sessionStorage.getItem("flexserver_compose_draft_vps-1_app-managed-1");
      expect(stored).toBeTruthy();
      const parsed = JSON.parse(stored!);
      expect(parsed.yaml).toBe("services:\n  custom: 1");
      // Secret value must NEVER be in draft
      expect(parsed.secretValue).toBeUndefined();
    });
  });

  it("loads cached application state when offline and disables mutation actions", async () => {
    sessionStorage.setItem(
      "flexserver_compose_cache_vps-1_app-managed-1",
      JSON.stringify({
        detail: mockDetail,
        operations: [mockOperation],
        cachedAt: "2026-10-20T10:00:00.000Z",
      }),
    );

    // Simulate network error on fetch
    vi.mocked(api.getVpsComposeApplication).mockRejectedValue(new Error("Network offline"));

    renderDetail();

    expect(await screen.findByText(/Offline mode:/i)).toBeTruthy();
    expect(screen.getByText("My Production Stack")).toBeTruthy();

    // Mutation buttons must be disabled
    const startBtn = screen.getByRole("button", { name: "Start" });
    const stopBtn = screen.getByRole("button", { name: "Stop" });
    const restartBtn = screen.getByRole("button", { name: "Restart" });
    const unmanageBtn = screen.getByRole("button", { name: "Unmanage" });

    expect(startBtn.hasAttribute("disabled")).toBe(true);
    expect(stopBtn.hasAttribute("disabled")).toBe(true);
    expect(restartBtn.hasAttribute("disabled")).toBe(true);
    expect(unmanageBtn.hasAttribute("disabled")).toBe(true);
  });

  it("handles adoption flow: reviews differences, requires approval checklist before confirmation", async () => {
    const readonlyDetail: ComposeAppDetail = {
      ...mockDetail,
      appId: "sha256-detected-stack",
      mode: "external_control",
      source: { verified: true, path: "/opt/app/compose.yml" },
    };
    vi.mocked(api.getVpsComposeApplication).mockResolvedValue(readonlyDetail);

    const mockAdoptionPreview: ComposeAdoptionPreview = {
      differences: [
        { field: "services.web.build", reason: "build context unsupported in managed stacks", paramPath: ["services", "web", "build"] },
      ],
      warnings: [
        { field: "services.db.ports", reason: "port bound to all interfaces", paramPath: ["services", "db", "ports"] },
      ],
      runtimeReady: true,
      digest: "sha256:adopt-digest-1234",
    };
    vi.mocked(api.getComposeAdoptionPreview).mockResolvedValue(mockAdoptionPreview);
    vi.mocked(api.adoptComposeApplication).mockResolvedValue({ ...readonlyDetail, mode: "managed" });

    renderDetail("sha256-detected-stack");
    await screen.findByText("Adopt into managed configuration");

    const reviewBtn = screen.getByRole("button", { name: /review adoption differences/i });
    fireEvent.click(reviewBtn);

    expect(await screen.findByText(/Differences detected/i)).toBeTruthy();
    expect(screen.getByText(/build context unsupported/i)).toBeTruthy();
    expect(screen.getByText("Adoption digest: sha256:adopt-digest-1234")).toBeTruthy();

    // Confirm adoption button should be disabled because differences not approved
    const adoptBtn = screen.getByRole("button", { name: /confirm adoption/i });
    expect(adoptBtn.hasAttribute("disabled")).toBe(true);

    // Approve the difference via checkbox
    const diffCheckbox = screen.getByRole("checkbox", { name: /confirm difference/i });
    fireEvent.click(diffCheckbox);

    // Now adoption should be enabled
    expect(adoptBtn.hasAttribute("disabled")).toBe(false);

    fireEvent.click(adoptBtn);
    await waitFor(() => {
      expect(api.adoptComposeApplication).toHaveBeenCalledWith(
        "vps-1",
        "sha256-detected-stack",
        expect.objectContaining({
          adoptionDigest: "sha256:adopt-digest-1234",
          approvedDifferences: expect.arrayContaining([expect.stringContaining("build")]),
        }),
      );
    });
  });

  it("configures readiness timeout with range validation (30-3600 seconds) and saves update", async () => {
    vi.mocked(api.updateComposeApplicationReadiness).mockResolvedValue({
      ...mockDetail,
      readinessSeconds: 450,
    });

    renderDetail();
    await screen.findByText("My Production Stack");

    const readinessInput = screen.getByLabelText("Readiness timeout in seconds") as HTMLInputElement;
    expect(readinessInput.value).toBe("300");

    const saveBtn = screen.getByRole("button", { name: "Save readiness" });
    expect(saveBtn.hasAttribute("disabled")).toBe(true); // unchanged

    // Set invalid value < 30
    fireEvent.change(readinessInput, { target: { value: "10" } });
    expect(saveBtn.hasAttribute("disabled")).toBe(true);

    // Set invalid value > 3600
    fireEvent.change(readinessInput, { target: { value: "4000" } });
    expect(saveBtn.hasAttribute("disabled")).toBe(true);

    // Set valid value 450
    fireEvent.change(readinessInput, { target: { value: "450" } });
    expect(saveBtn.hasAttribute("disabled")).toBe(false);

    fireEvent.click(saveBtn);
    await waitFor(() => {
      expect(api.updateComposeApplicationReadiness).toHaveBeenCalledWith("vps-1", "app-managed-1", 450);
      expect(screen.getByText("Readiness timeout updated.")).toBeTruthy();
    });
  });

  it("shows unmanage confirmation dialog explaining non-destructive workload preservation before unmanaging", async () => {
    vi.mocked(api.unmanageComposeApplication).mockResolvedValue({ mode: "unmanaged" });

    renderDetail();
    await screen.findByText("My Production Stack");

    const unmanageBtn = screen.getByRole("button", { name: "Unmanage" });
    fireEvent.click(unmanageBtn);

    // Alert dialog opens
    expect(await screen.findByText("Unmanage application")).toBeTruthy();
    expect(
      screen.getByText(/Running containers, named volumes, networks, and host files are NOT stopped or removed/i),
    ).toBeTruthy();

    const confirmAction = screen.getByRole("button", { name: "Confirm unmanage" });
    fireEvent.click(confirmAction);

    await waitFor(() => {
      expect(api.unmanageComposeApplication).toHaveBeenCalledWith("vps-1", "app-managed-1");
    });
  });

  it("displays downtime notice, container removal warnings, and wildcard port warnings in preview panel", async () => {
    const mockPreview: ComposePreview = {
      id: "prev-1",
      vpsId: "vps-1",
      appId: "app-managed-1",
      revisionSeq: 2,
      status: "ready",
      generation: 1,
      createdAt: "2026-10-20T10:00:00.000Z",
      digest: "sha256:prev-digest-9999",
      removedServices: ["old-worker"],
      result: {
        digest: "sha256:prev-digest-9999",
        redactedModel: {
          services: {
            app: {
              ports: ["0.0.0.0:8080:8080"],
            },
          },
        },
        imageDigests: {},
        removedServiceIds: ["old-worker"],
        observedFingerprint: "fingerprint-1",
        secretVersions: {},
        revisionSeq: 2,
        oneShotJobs: ["db-migrate"],
      },
    };
    vi.mocked(api.createComposePreview).mockResolvedValue({ previewId: "prev-1", status: "pending" });
    vi.mocked(api.getComposePreview).mockResolvedValue(mockPreview);

    renderDetail();
    await screen.findByText("My Production Stack");

    const yamlArea = screen.getByLabelText("Compose YAML");
    fireEvent.change(yamlArea, { target: { value: "services:\n  app:\n    ports:\n      - '0.0.0.0:8080:8080'" } });

    const createPreviewBtn = screen.getByRole("button", { name: "Create preview" });
    fireEvent.click(createPreviewBtn);

    // Downtime notice must be visible
    expect(await screen.findByText(/Downtime & recreate notice/i)).toBeTruthy();

    // Wildcard port exposure warning
    expect(await screen.findByText(/Wildcard port exposure warning/i)).toBeTruthy();

    // Container removal warning
    expect(screen.getByText(/Container removal warning/i)).toBeTruthy();
    expect(screen.getByText(/old-worker/i)).toBeTruthy();

    // Approved one-shot jobs
    expect(screen.getByText(/Approved one-shot jobs/i)).toBeTruthy();
    expect(screen.getByText(/db-migrate/i)).toBeTruthy();
  });

  it("displays operation history timeline with actor, timestamps, mutation status, revision, digest, and cursors", async () => {
    vi.mocked(api.listComposeOperations).mockResolvedValue({
      items: [mockOperation],
      nextCursor: "cursor-page-2",
    });

    const mockOlderOperation: ComposeOperation = {
      id: "op-older",
      vpsId: "vps-1",
      appId: "app-managed-1",
      kind: "verify_source",
      status: "succeeded",
      actor: { kind: "service", id: "ci-service" },
      createdAt: "2026-10-19T08:00:00.000Z",
      result: { outcome: "source_verified" },
    };

    renderDetail();
    await screen.findByText("My Production Stack");

    expect(screen.getByText(/Mutation started at/i)).toBeTruthy();
    expect(screen.getByText(/Revision #1/i)).toBeTruthy();
    expect(screen.getByText(/Digest: sha256:/i)).toBeTruthy();
    expect(screen.getByText(/Outcome:/i)).toBeTruthy();
    expect(screen.getByText("deployed")).toBeTruthy();
    expect(screen.getByText("Service outcomes:")).toBeTruthy();
    expect(screen.getByText(/recreated/)).toBeTruthy();

    // Cursor pagination button
    const loadOlderBtn = screen.getByRole("button", { name: /load older operations/i });
    expect(loadOlderBtn).toBeTruthy();

    vi.mocked(api.listComposeOperations).mockResolvedValueOnce({
      items: [mockOlderOperation],
      nextCursor: undefined,
    });

    fireEvent.click(loadOlderBtn);

    await waitFor(() => {
      expect(api.listComposeOperations).toHaveBeenCalledWith("vps-1", "app-managed-1", {
        cursor: "cursor-page-2",
      });
    });
  });
});
