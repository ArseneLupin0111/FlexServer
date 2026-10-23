import "../../../test/setup";
import { cleanup, fireEvent, render, screen, waitFor, within, act } from "@testing-library/react";
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

// jsdom's crypto may lack randomUUID, which task creation uses for
// idempotency keys.
if (typeof globalThis.crypto?.randomUUID !== "function") {
  const randomUUID = () => `idem-${Math.random().toString(36).slice(2)}`;
  if (globalThis.crypto) {
    Object.defineProperty(globalThis.crypto, "randomUUID", {
      configurable: true,
      value: randomUUID,
    });
  } else {
    Object.defineProperty(globalThis, "crypto", { configurable: true, value: { randomUUID } });
  }
}

import type { VpsRecord } from "../../../lib/api";
import type {
  AiConversation,
  AiConversationDetail,
  AiConversationMessage,
  AiPolicy,
  AiProviderSettings,
  AiTask,
  AiTaskUsage,
} from "../../../lib/ai-api";
import {
  checkAiProvider,
  createVpsAiTask,
  getAiSettings,
  getVpsAiCapability,
  getVpsAiConversation,
  getVpsAiPolicy,
  listVpsAiConversations,
  listVpsAiTasks,
} from "../../../lib/ai-api";

const streamHarness = vi.hoisted(() => ({
  latestOptions: null as null | { onSnapshot?: (task: AiTask) => void },
}));

vi.mock("../../../lib/ai-stream", () => ({
  useAiTaskStream: (options: { onSnapshot?: (task: AiTask) => void }) => {
    streamHarness.latestOptions = options;
    return {
      streamState: "idle" as const,
      outputChunks: [] as never[],
      hasGap: false,
      isTruncated: false,
      clearOutput: () => undefined,
      reconnect: () => undefined,
    };
  },
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
    getVpsAiConversation: vi.fn(),
    createVpsAiTask: vi.fn(),
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

const enabledPolicy: AiPolicy = {
  vpsId: "vps-1",
  aiEnabled: true,
  readEnabled: true,
  dockerActionsEnabled: true,
  composeActionsEnabled: true,
  shellEnabled: false,
  fileReadScopes: [],
  fileWriteScopes: [],
  serviceProfileIds: [],
  sendLogsToProvider: false,
  sendFilesToProvider: false,
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

const baseUsage: AiTaskUsage = {
  inputTokens: 12,
  outputTokens: 34,
  estimated: false,
  rounds: 1,
  toolCalls: 1,
};

function makeTask(overrides: Partial<AiTask> = {}): AiTask {
  return {
    id: "task-1",
    conversationId: "conv-1",
    vpsId: "vps-1",
    state: "succeeded",
    revision: 2,
    requestSummary: "Prune unused docker images",
    usage: baseUsage,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:01:00.000Z",
    ...overrides,
  };
}

function makeConversation(overrides: Partial<AiConversation> = {}): AiConversation {
  return {
    id: "conv-1",
    vpsId: "vps-1",
    title: "Maintenance",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:01:00.000Z",
    ...overrides,
  };
}

function makeMessage(overrides: Partial<AiConversationMessage> = {}): AiConversationMessage {
  return {
    id: "m-1",
    conversationId: "conv-1",
    taskId: "task-1",
    role: "user",
    content: "Please prune unused docker images",
    createdAt: "2026-01-01T00:00:30.000Z",
    ...overrides,
  };
}

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

function mockAssistantLoaded(options: {
  tasks: AiTask[];
  conversationDetail: AiConversationDetail | null;
  policy?: AiPolicy | null;
}) {
  vi.mocked(getAiSettings).mockResolvedValue(savedSettings);
  if (options.policy === null) {
    vi.mocked(getVpsAiPolicy).mockRejectedValue(new Error("policy unavailable"));
  } else {
    vi.mocked(getVpsAiPolicy).mockResolvedValue(options.policy ?? enabledPolicy);
  }
  vi.mocked(getVpsAiCapability).mockRejectedValue(new Error("capability unavailable"));
  vi.mocked(listVpsAiTasks).mockResolvedValue(options.tasks);
  vi.mocked(listVpsAiConversations).mockResolvedValue(
    options.conversationDetail ? [options.conversationDetail.conversation] : [],
  );
  if (options.conversationDetail) {
    vi.mocked(getVpsAiConversation).mockResolvedValue(options.conversationDetail);
  }
}

// Summaries must be readable inside the chat log region; the task details
// panel also renders task summaries and must not satisfy these assertions.
function getChatLog(): HTMLElement {
  return screen.getByRole("log", { name: "Assistant messages" });
}

async function openSettingsModal() {
  fireEvent.click(await screen.findByRole("button", { name: /^settings$/i }));
  return screen.findByRole("heading", { name: /ai assistant settings & policy/i });
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  streamHarness.latestOptions = null;
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

describe("AssistantPanel final result in chat", () => {
  it("shows the finished task summary in the chat when persisted conversation messages omit it", async () => {
    const summary = "Pruned 4 dangling images and reclaimed 1.8 GB of disk space.";
    mockAssistantLoaded({
      tasks: [makeTask({ state: "succeeded", summary })],
      conversationDetail: {
        conversation: makeConversation(),
        messages: [
          makeMessage({ id: "m-1", role: "user" }),
          // Earlier assistant turn without the final result must not
          // suppress the task summary.
          makeMessage({ id: "m-2", role: "assistant", content: "Inspecting docker images on host-1..." }),
        ],
      },
    });

    renderPanel();
    await screen.findByText("Inspecting docker images on host-1...");

    expect(within(getChatLog()).getByText(summary)).toBeInTheDocument();
  });

  it("does not duplicate a summary the conversation already persisted for the same task", async () => {
    const summary = "Pruned 4 dangling images and reclaimed 1.8 GB of disk space.";
    mockAssistantLoaded({
      tasks: [makeTask({ state: "succeeded", summary })],
      conversationDetail: {
        conversation: makeConversation(),
        messages: [
          makeMessage({ id: "m-1", role: "user" }),
          makeMessage({ id: "m-2", role: "assistant", content: summary }),
        ],
      },
    });

    renderPanel();
    await screen.findByText("Please prune unused docker images");

    expect(within(getChatLog()).getAllByText(summary)).toHaveLength(1);
  });

  it("shows the task summary in the chat when a live SSE snapshot completes the task without a persisted assistant message", async () => {
    mockAssistantLoaded({
      tasks: [makeTask({ state: "executing", summary: undefined })],
      conversationDetail: {
        conversation: makeConversation(),
        messages: [makeMessage({ id: "m-1", role: "user" })],
      },
    });

    renderPanel();
    await screen.findByText("Please prune unused docker images");

    const summary = "Verified nginx is healthy and pruned 2 unused images.";
    await act(async () => {
      streamHarness.latestOptions?.onSnapshot?.(
        makeTask({ state: "succeeded", summary }),
      );
    });

    expect(within(getChatLog()).getByText(summary)).toBeInTheDocument();
  });

  it("falls back to the selected task request summary when the conversation has no user turn for it", async () => {
    mockAssistantLoaded({
      tasks: [
        makeTask({
          requestSummary: "Restart the nginx service",
          summary: "Restarted nginx and verified it responds on port 443.",
        }),
      ],
      conversationDetail: {
        conversation: makeConversation(),
        messages: [
          makeMessage({ id: "m-2", role: "assistant", content: "Working on the restart..." }),
        ],
      },
    });

    renderPanel();
    await screen.findByText("Working on the restart...");

    const chat = getChatLog();
    // Exactly one user turn: synthesized from requestSummary, never duplicated.
    expect(within(chat).getAllByText("Restart the nginx service")).toHaveLength(1);
    expect(within(chat).getByText("Restarted nginx and verified it responds on port 443.")).toBeInTheDocument();
  });
});

describe("AssistantPanel conversation sync", () => {
  it("keeps a new chat after sending: adopts the created conversation and shows its live final summary", async () => {
    const staleRequest = "Old conversation request from the previous session";
    mockAssistantLoaded({
      tasks: [],
      conversationDetail: {
        conversation: makeConversation({ id: "conv-old", title: "Previous Session" }),
        messages: [
          makeMessage({
            id: "m-old",
            conversationId: "conv-old",
            taskId: undefined,
            role: "user",
            content: staleRequest,
          }),
        ],
      },
    });
    const request = "Rotate the tls certificates";
    vi.mocked(createVpsAiTask).mockResolvedValue(
      makeTask({
        id: "task-new",
        conversationId: "conv-new",
        state: "planning",
        revision: 1,
        requestSummary: request,
        summary: undefined,
      }),
    );

    renderPanel();
    await screen.findByText(staleRequest);

    fireEvent.click(screen.getByRole("button", { name: /new chat/i }));
    expect(await screen.findByText(/how can the assistant help\?/i)).toBeInTheDocument();
    expect(screen.queryByText(staleRequest)).toBeNull();

    fireEvent.change(screen.getByPlaceholderText(/ask the assistant/i), {
      target: { value: request },
    });
    fireEvent.click(screen.getByRole("button", { name: /send/i }));

    await waitFor(() => {
      expect(createVpsAiTask).toHaveBeenCalledTimes(1);
    });
    expect(createVpsAiTask).toHaveBeenCalledWith("vps-1", {
      request,
      idempotencyKey: expect.any(String),
      conversationId: undefined,
    });

    // The optimistic turn survives the ?taskId= URL write (no reload back to
    // the latest conversation) and is not duplicated by the requestSummary
    // fallback.
    const chat = getChatLog();
    await waitFor(() => {
      expect(within(chat).getAllByText(request)).toHaveLength(1);
    });
    expect(within(chat).queryByText(staleRequest)).toBeNull();

    const summary = "Rotated certificates and reloaded nginx.";
    await act(async () => {
      streamHarness.latestOptions?.onSnapshot?.(
        makeTask({
          id: "task-new",
          conversationId: "conv-new",
          state: "succeeded",
          requestSummary: request,
          summary,
        }),
      );
    });
    // Summary is projected only for the adopted conversation.
    expect(within(getChatLog()).getByText(summary)).toBeInTheDocument();
    expect(within(getChatLog()).queryByText(staleRequest)).toBeNull();
  });

  it("preserves a selected history conversation across the taskId URL write", async () => {
    const oldSummary = "Restarted nginx on the older session.";
    mockAssistantLoaded({
      tasks: [
        makeTask({
          id: "task-latest",
          conversationId: "conv-latest",
          state: "executing",
          requestSummary: "Check the latest session",
          summary: undefined,
        }),
        makeTask({
          id: "task-old",
          conversationId: "conv-old",
          summary: oldSummary,
        }),
      ],
      conversationDetail: null,
    });
    vi.mocked(getVpsAiConversation).mockImplementation(
      async (_vpsId: string, convId: string) => {
        if (convId === "conv-old") {
          return {
            conversation: makeConversation({ id: "conv-old", title: "Older Session" }),
            messages: [
              makeMessage({
                id: "m-old-1",
                conversationId: "conv-old",
                taskId: "task-old",
                role: "user",
                content: "Restart nginx on the older session",
              }),
              makeMessage({
                id: "m-old-2",
                conversationId: "conv-old",
                taskId: "task-old",
                role: "assistant",
                content: "Working on it...",
              }),
            ],
          };
        }
        return {
          conversation: makeConversation({ id: "conv-latest", title: "Latest Session" }),
          messages: [
            makeMessage({
              id: "m-latest-1",
              conversationId: "conv-latest",
              taskId: undefined,
              role: "user",
              content: "Latest conversation marker",
            }),
          ],
        };
      },
    );
    vi.mocked(listVpsAiConversations).mockResolvedValue([
      makeConversation({ id: "conv-latest", title: "Latest Session" }),
      makeConversation({ id: "conv-old", title: "Older Session" }),
    ]);

    renderPanel();
    await screen.findByText("Latest conversation marker");

    fireEvent.click(screen.getByRole("button", { name: /^history$/i }));
    fireEvent.click(await screen.findByRole("button", { name: /older session/i }));

    // Selecting the older conversation writes ?taskId=task-old; the panel
    // must keep the older conversation, not reset to the latest one.
    await waitFor(() => {
      expect(within(getChatLog()).getByText("Restart nginx on the older session")).toBeInTheDocument();
    });
    const chat = getChatLog();
    expect(within(chat).queryByText("Latest conversation marker")).toBeNull();
    expect(within(chat).getByText(oldSummary)).toBeInTheDocument();
  });

  it("keeps a new chat empty across a manual refresh", async () => {
    const latestRequest = "Latest conversation request marker";
    mockAssistantLoaded({
      tasks: [],
      conversationDetail: {
        conversation: makeConversation(),
        messages: [
          makeMessage({
            id: "m-1",
            taskId: undefined,
            role: "user",
            content: latestRequest,
          }),
        ],
      },
    });

    renderPanel();
    await screen.findByText(latestRequest);

    fireEvent.click(screen.getByRole("button", { name: /new chat/i }));
    expect(await screen.findByText(/how can the assistant help\?/i)).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /^refresh$/i }));
    await waitFor(() => {
      expect(listVpsAiTasks).toHaveBeenCalledTimes(2);
    });

    // Explicit New Chat (null selection) must not fall through to the
    // latest conversation on refresh.
    expect(screen.getByText(/how can the assistant help\?/i)).toBeInTheDocument();
    expect(within(getChatLog()).queryByText(latestRequest)).toBeNull();
  });

  it("keeps the operator's question above the live summary when the client clock runs ahead of the server", async () => {
    // Client clock is 2 minutes ahead of every server timestamp below.
    vi.useFakeTimers({ toFake: ["Date"], now: new Date("2026-01-01T00:02:00.000Z") });
    try {
      mockAssistantLoaded({ tasks: [], conversationDetail: null });
      const request = "List running containers";
      const summary = "Found 6 running containers.";
      vi.mocked(createVpsAiTask).mockResolvedValue(
        makeTask({
          id: "task-new",
          conversationId: "conv-new",
          state: "planning",
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:05.000Z",
          requestSummary: request,
          summary: undefined,
        }),
      );

      renderPanel();
      await screen.findByText(/how can the assistant help\?/i);

      fireEvent.change(screen.getByPlaceholderText(/ask the assistant/i), {
        target: { value: request },
      });
      fireEvent.click(screen.getByRole("button", { name: /send/i }));

      await waitFor(() => {
        expect(createVpsAiTask).toHaveBeenCalledTimes(1);
      });

      await act(async () => {
        streamHarness.latestOptions?.onSnapshot?.(
          makeTask({
            id: "task-new",
            conversationId: "conv-new",
            state: "succeeded",
            createdAt: "2026-01-01T00:00:00.000Z",
            updatedAt: "2026-01-01T00:00:20.000Z",
            requestSummary: request,
            summary,
          }),
        );
      });

      // Document order: the question must precede the AI summary (the
      // optimistic turn is reconciled to the server task's createdAt).
      const chat = getChatLog();
      await waitFor(() => {
        const question = within(chat).getByText(request);
        const answer = within(chat).getByText(summary);
        expect(
          question.compareDocumentPosition(answer) & Node.DOCUMENT_POSITION_FOLLOWING,
        ).toBeTruthy();
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("projects a final summary that arrives only via the refreshed task list", async () => {
    const summary = "Pruned 3 images after the refresh completed.";
    mockAssistantLoaded({
      tasks: [makeTask({ state: "succeeded", summary })],
      conversationDetail: {
        conversation: makeConversation(),
        messages: [makeMessage({ id: "m-1", role: "user" })],
      },
    });
    vi.mocked(listVpsAiTasks).mockResolvedValueOnce([
      makeTask({ state: "executing", summary: undefined }),
    ]);

    renderPanel();
    await screen.findByText("Please prune unused docker images");
    expect(within(getChatLog()).queryByText(summary)).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: /^refresh$/i }));

    // The refreshed task list must not be shadowed by the stale activeTask
    // snapshot from the initial load.
    await waitFor(() => {
      expect(within(getChatLog()).getByText(summary)).toBeInTheDocument();
    });
  });
});

describe("AssistantPanel chat markdown rendering", () => {
  it("renders markdown in assistant chat messages as semantic HTML instead of literal markup", async () => {
    const markdown = [
      "Docker **health report** for host-1:",
      "",
      "- nginx proxy is up",
      "- 2 dangling images pruned",
      "",
      "| Service | Status |",
      "| --- | --- |",
      "| nginx | up |",
      "",
      "Verify with `docker ps --filter name=nginx`.",
    ].join("\n");
    mockAssistantLoaded({
      tasks: [],
      conversationDetail: {
        conversation: makeConversation(),
        messages: [
          makeMessage({ id: "m-1", role: "user", content: "Give me a docker status report" }),
          makeMessage({ id: "m-2", role: "assistant", content: markdown }),
        ],
      },
    });

    renderPanel();
    await screen.findByText("Give me a docker status report");

    const chat = getChatLog();

    const strong = chat.querySelector("strong");
    expect(strong, "expected a <strong> element for **bold** text").not.toBeNull();
    expect(strong?.textContent).toBe("health report");

    const listItems = Array.from(chat.querySelectorAll("ul li")).map(
      (li) => li.textContent,
    );
    expect(listItems).toContain("nginx proxy is up");
    expect(listItems).toContain("2 dangling images pruned");

    const table = chat.querySelector("table");
    expect(table, "expected a <table> element for pipe tables").not.toBeNull();
    const headers = Array.from(table?.querySelectorAll("th") ?? []).map(
      (th) => th.textContent,
    );
    expect(headers).toEqual(["Service", "Status"]);
    const cells = Array.from(table?.querySelectorAll("td") ?? []).map(
      (td) => td.textContent,
    );
    expect(cells).toEqual(["nginx", "up"]);

    const code = chat.querySelector("code");
    expect(code, "expected a <code> element for `inline code`").not.toBeNull();
    expect(code?.textContent).toBe("docker ps --filter name=nginx");
  });
});
