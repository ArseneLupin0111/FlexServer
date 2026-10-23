import "../../../test/setup";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter } from "react-router-dom";
import { AssistantPanel } from "./AssistantPanel";

// jsdom has no scroll engine. The shared setup preserves Element.scrollTo;
// AssistantChat additionally autoscrolls via Element.scrollIntoView.
Object.defineProperty(Element.prototype, "scrollIntoView", {
  configurable: true,
  writable: true,
  value: () => undefined,
});
import type { VpsRecord } from "../../../lib/api";
import type { AiProviderSettings } from "../../../lib/ai-api";
import {
  checkAiProvider,
  getAiSettings,
  getVpsAiCapability,
  getVpsAiPolicy,
  listVpsAiConversations,
  listVpsAiTasks,
} from "../../../lib/ai-api";

// The panel owns no active task in these tests; stub the SSE stream client
// so no EventSource is constructed under jsdom.
vi.mock("../../../lib/ai-stream", () => ({
  useAiTaskStream: () => ({
    streamState: "idle" as const,
    outputChunks: [] as never[],
    hasGap: false,
    isTruncated: false,
    clearOutput: () => undefined,
    reconnect: () => undefined,
  }),
}));

// Keep the real module (other assistant children import runtime helpers from
// it) and override only the transport functions the panel drives.
vi.mock("../../../lib/ai-api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../lib/ai-api")>();
  return {
    ...actual,
    getAiSettings: vi.fn(),
    getVpsAiPolicy: vi.fn(),
    getVpsAiCapability: vi.fn(),
    listVpsAiTasks: vi.fn(),
    listVpsAiConversations: vi.fn(),
    checkAiProvider: vi.fn(),
  };
});

const savedSettings: AiProviderSettings = {
  endpoint: "https://provider.example",
  model: "test-model",
  hasApiKey: true,
  allowPrivateEndpoint: false,
  revision: 1,
  updatedAt: "2026-01-01T00:00:00.000Z",
};

const testVps: VpsRecord = {
  id: "vps-1",
  name: "host-1",
  host: "192.0.2.10",
  port: 22,
  username: "root",
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
};

function renderPanel() {
  return render(
    <MemoryRouter>
      <AssistantPanel vps={testVps} />
    </MemoryRouter>,
  );
}

function mockLoadedProvider() {
  vi.mocked(getAiSettings).mockResolvedValue(savedSettings);
  // The panel tolerates these being unavailable (catch -> null).
  vi.mocked(getVpsAiPolicy).mockRejectedValue(new Error("policy unavailable"));
  vi.mocked(getVpsAiCapability).mockRejectedValue(new Error("capability unavailable"));
  vi.mocked(listVpsAiTasks).mockResolvedValue([]);
  vi.mocked(listVpsAiConversations).mockResolvedValue([]);
}

async function openSettingsModal() {
  fireEvent.click(await screen.findByRole("button", { name: /^settings$/i }));
  return screen.findByRole("heading", { name: /ai assistant settings & policy/i });
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("AssistantPanel provider check", () => {
  it("reports a failed check in the modal instead of a false green result when the check API rejects", async () => {
    mockLoadedProvider();
    vi.mocked(checkAiProvider).mockRejectedValueOnce(
      new Error("Provider check failed: 401 invalid api key"),
    );

    renderPanel();
    await openSettingsModal();

    fireEvent.click(screen.getByRole("button", { name: /check endpoint/i }));

    await waitFor(() => {
      expect(checkAiProvider).toHaveBeenCalledTimes(1);
    });

    // The rejected check must never be presented as an operational endpoint.
    expect(screen.queryByText(/synthetic tool check succeeded/i)).toBeNull();
    expect(screen.queryByText(/endpoint is operational/i)).toBeNull();

    // The failure must be surfaced to the user (modal result and/or root banner).
    await waitFor(() => {
      expect(screen.getAllByText(/401 invalid api key/i).length).toBeGreaterThan(0);
    });
  });

  it("still shows the operational success message when the check API resolves", async () => {
    mockLoadedProvider();
    vi.mocked(checkAiProvider).mockResolvedValueOnce({ ok: true });

    renderPanel();
    await openSettingsModal();

    fireEvent.click(screen.getByRole("button", { name: /check endpoint/i }));

    await waitFor(() => {
      expect(screen.getByText(/synthetic tool check succeeded/i)).toBeInTheDocument();
    });
  });
});
