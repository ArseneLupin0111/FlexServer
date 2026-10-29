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
  AiProviderProfile,
  AiProvidersResponse,
  AiProviderSettings,
  AiTask,
  AiTaskUsage,
} from "../../../lib/ai-api";
import {
  authorizeAiProviderOauth,
  checkAiProviderProfile,
  createVpsAiTask,
  exchangeAiProviderOauth,
  getAiSettings,
  getVpsAiCapability,
  getVpsAiConversation,
  getVpsAiPolicy,
  listAiProviders,
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
// it) and override only the transport functions the panel drives. The
// provider list defaults to empty so generic tests exercise the no-profile
// paths; multi-provider tests override it after the shared boot helpers.
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
    listAiProviders: vi.fn(() =>
      Promise.resolve({ providers: [], lastSelection: undefined, migrated: true }),
    ),
    checkAiProviderProfile: vi.fn(),
    authorizeAiProviderOauth: vi.fn(),
    exchangeAiProviderOauth: vi.fn(),
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
  execMode: "sandbox",
  privilegedAcknowledgedAt: null,
  privilegedAcknowledgedBy: null,
  autoApprove: false,
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

function makeProfile(overrides: Partial<AiProviderProfile> = {}): AiProviderProfile {
  return {
    id: "prov-1",
    name: "Primary",
    endpoint: "https://primary.example/v1",
    models: ["m-1"],
    defaultModel: "m-1",
    enabled: true,
    isDefault: true,
    hasApiKey: true,
    allowPrivateEndpoint: false,
    authKind: "apiKey",
    revision: 1,
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

function makeProvidersResponse(
  providers: AiProviderProfile[],
  lastSelection?: AiProvidersResponse["lastSelection"],
): AiProvidersResponse {
  return { providers, lastSelection, migrated: true };
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
  vi.mocked(listAiProviders).mockResolvedValue(makeProvidersResponse([]));
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
  vi.mocked(listAiProviders).mockResolvedValue(makeProvidersResponse([]));
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
  const checkProfile = makeProfile({
    id: "prov-check",
    name: "Check target",
    endpoint: "https://check.example/v1",
    models: ["check-model"],
    defaultModel: "check-model",
  });

  it("reports a failed profile check in the modal instead of a false green result when the check API rejects", async () => {
    mockLoadedProvider();
    vi.mocked(listAiProviders).mockResolvedValue(
      makeProvidersResponse([checkProfile]),
    );
    vi.mocked(checkAiProviderProfile).mockRejectedValueOnce(
      new Error("Provider check failed: 401 invalid api key"),
    );

    renderPanel();
    await openSettingsModal();

    fireEvent.click(
      screen.getByRole("button", { name: /check provider check target/i }),
    );

    await waitFor(() => {
      expect(checkAiProviderProfile).toHaveBeenCalledWith("prov-check");
    });

    // The rejected check must never be presented as an operational endpoint.
    expect(screen.queryByText(/provider check succeeded/i)).toBeNull();
    expect(screen.queryByText(/endpoint is operational/i)).toBeNull();

    // The failure must be surfaced to the user (modal row result and/or root banner).
    await waitFor(() => {
      expect(screen.getAllByText(/401 invalid api key/i).length).toBeGreaterThan(0);
    });
  });

  it("still shows the operational success message when the profile check API resolves", async () => {
    mockLoadedProvider();
    vi.mocked(listAiProviders).mockResolvedValue(
      makeProvidersResponse([checkProfile]),
    );
    vi.mocked(checkAiProviderProfile).mockResolvedValueOnce({ ok: true });

    renderPanel();
    await openSettingsModal();

    fireEvent.click(
      screen.getByRole("button", { name: /check provider check target/i }),
    );

    await waitFor(() => {
      expect(screen.getByText(/provider check succeeded/i)).toBeInTheDocument();
    });
  });
});

describe("AssistantPanel ChatGPT OAuth paste-back", () => {
  const oauthProfile = makeProfile({
    id: "prov-oauth",
    name: "ChatGPT",
    endpoint: "https://chatgpt.com/backend-api/codex/responses",
    models: ["gpt-5-codex", "gpt-5.1-codex"],
    defaultModel: "gpt-5-codex",
    hasApiKey: false,
    authKind: "chatgpt_oauth",
    isDefault: false,
  });
  const authorizeUrl = "https://auth.openai.com/authorize?client_id=app_x&state=s1";

  it("runs authorize, paste-back, and exchange, then refreshes the providers list", async () => {
    mockLoadedProvider();
    vi.mocked(listAiProviders)
      .mockResolvedValueOnce(makeProvidersResponse([oauthProfile]))
      .mockResolvedValue(
        makeProvidersResponse([{ ...oauthProfile, tokenState: "connected" }]),
      );
    vi.mocked(authorizeAiProviderOauth).mockResolvedValue({ authorizeUrl });
    vi.mocked(exchangeAiProviderOauth).mockResolvedValue({
      profile: { ...oauthProfile, tokenState: "connected" },
      expiresAt: "2026-01-01T05:00:00.000Z",
      lastRefreshedAt: "2026-01-01T00:00:00.000Z",
    });
    const openSpy = vi.spyOn(window, "open").mockReturnValue(null);

    renderPanel();
    await openSettingsModal();

    // ToS acknowledgment gates the authorize button.
    expect(
      screen.getByRole("button", { name: /open authorize url for chatgpt/i }),
    ).toBeDisabled();
    fireEvent.click(
      screen.getByRole("checkbox", { name: /i understand the oauth risk/i }),
    );
    fireEvent.click(
      screen.getByRole("button", { name: /open authorize url for chatgpt/i }),
    );

    await waitFor(() => {
      expect(authorizeAiProviderOauth).toHaveBeenCalledWith("prov-oauth");
    });
    await waitFor(() => {
      expect(openSpy).toHaveBeenCalledWith(authorizeUrl, "_blank", "noopener,noreferrer");
    });

    const paste = await screen.findByLabelText("OAuth callback URL");
    fireEvent.change(paste, {
      target: { value: "http://localhost:1455/auth/callback?code=abc&state=s1" },
    });
    fireEvent.click(
      screen.getByRole("button", { name: /connect oauth login for chatgpt/i }),
    );

    await waitFor(() => {
      expect(exchangeAiProviderOauth).toHaveBeenCalledWith(
        "prov-oauth",
        "http://localhost:1455/auth/callback?code=abc&state=s1",
      );
    });
    // The panel owns the refresh: initial load plus the post-exchange reload.
    await waitFor(() => {
      expect(vi.mocked(listAiProviders).mock.calls.length).toBeGreaterThanOrEqual(2);
    });
    expect(await screen.findByText(/token expires/i)).toBeInTheDocument();
    expect(await screen.findByText("Connected")).toBeInTheDocument();
  });

  it("surfaces a rejected exchange as an error without a false connected state", async () => {
    mockLoadedProvider();
    vi.mocked(listAiProviders).mockResolvedValue(
      makeProvidersResponse([oauthProfile]),
    );
    vi.mocked(authorizeAiProviderOauth).mockResolvedValue({ authorizeUrl });
    vi.mocked(exchangeAiProviderOauth).mockRejectedValue(new Error("state mismatch"));
    vi.spyOn(window, "open").mockReturnValue(null);

    renderPanel();
    await openSettingsModal();

    fireEvent.click(
      screen.getByRole("checkbox", { name: /i understand the oauth risk/i }),
    );
    fireEvent.click(
      screen.getByRole("button", { name: /open authorize url for chatgpt/i }),
    );
    const paste = await screen.findByLabelText("OAuth callback URL");
    fireEvent.change(paste, {
      target: { value: "http://localhost:1455/auth/callback?code=abc&state=bad" },
    });
    fireEvent.click(
      screen.getByRole("button", { name: /connect oauth login for chatgpt/i }),
    );

    // Surfaced by the modal's OAuth section and/or the panel root banner.
    expect((await screen.findAllByText(/state mismatch/i)).length).toBeGreaterThan(0);
    expect(screen.queryByText("Connected")).toBeNull();
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

    // Narrow viewport (jsdom): history is a drawer, closed by default. The
    // History button opens it; selecting a conversation must not reset to
    // the latest one after ?taskId= is set, and closes the drawer.
    const historyToggle = screen.getByRole("button", { name: /^history$/i });
    expect(historyToggle).toHaveAttribute("aria-expanded", "false");
    fireEvent.click(historyToggle);
    expect(historyToggle).toHaveAttribute("aria-expanded", "true");
    fireEvent.click(screen.getByRole("button", { name: /older session/i }));

    // Selecting the older conversation writes ?taskId=task-old; the panel
    // must keep the older conversation, not reset to the latest one.
    await waitFor(() => {
      expect(within(getChatLog()).getByText("Restart nginx on the older session")).toBeInTheDocument();
    });
    const chat = getChatLog();
    expect(within(chat).queryByText("Latest conversation marker")).toBeNull();
    expect(within(chat).getByText(oldSummary)).toBeInTheDocument();

    // Selecting from the drawer closes it; the History button re-opens it.
    expect(screen.getByRole("button", { name: /^history$/i })).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByRole("button", { name: /older session/i })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /^history$/i }));
    expect(screen.getByRole("button", { name: /older session/i })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /^history$/i }));
    expect(screen.queryByRole("button", { name: /older session/i })).toBeNull();
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

describe("AssistantPanel auto-compact indicator", () => {
  it("shows only the minimal Auto-compact status while the live snapshot flags compaction, then clears it", async () => {
    mockAssistantLoaded({
      tasks: [makeTask({ state: "executing", summary: undefined })],
      conversationDetail: {
        conversation: makeConversation(),
        messages: [makeMessage({ id: "m-1", role: "user" })],
      },
    });

    renderPanel();
    await screen.findByText("Please prune unused docker images");

    // No compaction flag yet: no indicator, no status region.
    expect(screen.queryByRole("status")).toBeNull();
    expect(screen.queryByText("Auto-compact")).toBeNull();

    await act(async () => {
      streamHarness.latestOptions?.onSnapshot?.(
        makeTask({ state: "executing", summary: undefined, compacting: true }),
      );
    });

    const indicator = screen.getByRole("status");
    expect(indicator).toHaveTextContent("Auto-compact");
    // Minimal, non-intrusive: a single inline text indicator, not a modal or
    // a status paragraph beyond the label itself.
    expect(screen.queryByText(/compacting conversation/i)).toBeNull();
    // Existing task state row is preserved alongside the indicator.
    expect(screen.getByText("executing")).toBeInTheDocument();

    await act(async () => {
      streamHarness.latestOptions?.onSnapshot?.(
        makeTask({ state: "executing", summary: undefined, compacting: false }),
      );
    });

    expect(screen.queryByRole("status")).toBeNull();
    expect(screen.queryByText("Auto-compact")).toBeNull();
  });

  it("never infers Auto-compact from the planning state when the transient flag is absent", async () => {
    mockAssistantLoaded({
      tasks: [makeTask({ state: "planning", summary: undefined })],
      conversationDetail: {
        conversation: makeConversation(),
        messages: [makeMessage({ id: "m-1", role: "user" })],
      },
    });

    renderPanel();
    await screen.findByText("Please prune unused docker images");

    expect(screen.getByText("planning")).toBeInTheDocument();
    expect(screen.queryByRole("status")).toBeNull();
    expect(screen.queryByText("Auto-compact")).toBeNull();
  });
});

// Conversation pagination: latest-200 window and older pages.

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

function makeWindowedMessages(
  conversationId: string,
  total: number,
): AiConversationMessage[] {
  const base = Date.UTC(2026, 0, 1, 0, 0, 0);
  return Array.from({ length: total }, (_, index) =>
    makeMessage({
      id: `m-${String(index).padStart(3, "0")}`,
      conversationId,
      taskId: undefined,
      role: index % 2 === 0 ? "user" : "assistant",
      content: `Paged message ${index}`,
      createdAt: new Date(base + index * 1000).toISOString(),
    }),
  );
}

function makeLabeledMessages(
  conversationId: string,
  label: string,
  count: number,
): AiConversationMessage[] {
  const base = Date.UTC(2026, 0, 2, 0, 0, 0);
  return Array.from({ length: count }, (_, index) =>
    makeMessage({
      id: `${label.toLowerCase()}-${index}`,
      conversationId,
      taskId: undefined,
      role: index % 2 === 0 ? "user" : "assistant",
      content: `${label} message ${index + 1}`,
      createdAt: new Date(base + index * 1000).toISOString(),
    }),
  );
}

// Boots the boot-time transports for a host whose only conversation holds
// `total` messages; pageOf serves exact [offset, offset+limit) windows like
// the real API.
function setupWindowedConversationHost(total: number) {
  const conversation = makeConversation({ id: "conv-paged", title: "Paged Session" });
  const messages = makeWindowedMessages(conversation.id, total);
  vi.mocked(getAiSettings).mockResolvedValue(savedSettings);
  vi.mocked(listAiProviders).mockResolvedValue(makeProvidersResponse([]));
  vi.mocked(getVpsAiPolicy).mockResolvedValue(enabledPolicy);
  vi.mocked(getVpsAiCapability).mockRejectedValue(new Error("capability unavailable"));
  vi.mocked(listVpsAiTasks).mockResolvedValue([]);
  vi.mocked(listVpsAiConversations).mockResolvedValue([conversation]);
  const pageOf = (offset: number, limit: number): AiConversationDetail => ({
    conversation,
    messages: messages.slice(offset, offset + limit),
    total: messages.length,
  });
  return { conversation, pageOf };
}

// Two-conversation host (A is the initial selection: first in the list, no
// tasks) for selection-vs-pagination races.
function setupTwoConversationHost(titleA: string, titleB: string) {
  const conversationA = makeConversation({ id: "conv-a", title: titleA });
  const conversationB = makeConversation({ id: "conv-b", title: titleB });
  vi.mocked(getAiSettings).mockResolvedValue(savedSettings);
  vi.mocked(listAiProviders).mockResolvedValue(makeProvidersResponse([]));
  vi.mocked(getVpsAiPolicy).mockResolvedValue(enabledPolicy);
  vi.mocked(getVpsAiCapability).mockRejectedValue(new Error("capability unavailable"));
  vi.mocked(listVpsAiTasks).mockResolvedValue([]);
  vi.mocked(listVpsAiConversations).mockResolvedValue([conversationA, conversationB]);
  return { conversationA, conversationB };
}

describe("AssistantPanel conversation pagination", () => {
  it("initially renders only the latest 200 messages and offers the older window", async () => {
    const { conversation, pageOf } = setupWindowedConversationHost(350);
    vi.mocked(getVpsAiConversation).mockImplementation(
      async (_vpsId, _conversationId, _signal, offset = 0, limit = 200) =>
        pageOf(offset, limit),
    );

    renderPanel();

    expect(await screen.findByText("Paged message 349")).toBeInTheDocument();
    const chat = getChatLog();
    expect(within(chat).getByText("Paged message 150")).toBeInTheDocument();
    expect(within(chat).queryByText("Paged message 149")).toBeNull();
    expect(within(chat).getAllByRole("article")).toHaveLength(200);
    expect(
      screen.getByRole("button", { name: /load older messages/i }),
    ).toBeInTheDocument();

    // Wire protocol: a 1-message probe for the total, then the latest
    // window at offset total-200 (window size comes from the transport's
    // default limit of 200).
    const calls = vi.mocked(getVpsAiConversation).mock.calls;
    expect(calls).toHaveLength(2);
    expect(calls[0]?.[1]).toBe(conversation.id);
    expect(calls[0]?.[3]).toBe(0);
    expect(calls[0]?.[4]).toBe(1);
    expect(calls[1]?.[3]).toBe(150);
    expect(calls[1]?.[4]).toBeUndefined();
  });

  it("refreshes the latest page when a message arrives between the total probe and page request", async () => {
    const { conversation, pageOf } = setupWindowedConversationHost(350);
    let appended = false;
    vi.mocked(getVpsAiConversation).mockImplementation(async (_vpsId, _conversationId, _signal, offset = 0, limit = 200) => {
      if (limit === 1) return pageOf(0, 1);
      if (!appended) {
        appended = true;
        return { ...pageOf(offset, limit), remaining: 1 };
      }
      return {
        ...pageOf(offset + 1, limit - 1),
        messages: [...pageOf(offset + 1, limit - 1).messages, makeMessage({ id: "newest", taskId: undefined, content: "Fresh tail message" })],
        total: 351,
        remaining: 0,
      };
    });
    renderPanel();
    await screen.findByText("Fresh tail message");
    expect(vi.mocked(getVpsAiConversation).mock.calls.map(call => call[3])).toEqual([0, 150, 151]);
  });

  it("prepends the older window on demand, dedupes overlap, and retires the pager when history is exhausted", async () => {
    const { conversation, pageOf } = setupWindowedConversationHost(350);
    const olderPage = deferred<AiConversationDetail>();
    vi.mocked(getVpsAiConversation).mockImplementation(
      async (_vpsId, conversationId, _signal, offset = 0, limit = 200) => {
        // Hold the [0, 150) window back so the in-flight UI is observable.
        if (conversationId === conversation.id && offset === 0 && limit === 150) {
          return olderPage.promise;
        }
        return pageOf(offset, limit);
      },
    );

    renderPanel();
    await screen.findByText("Paged message 349");

    fireEvent.click(screen.getByRole("button", { name: /load older messages/i }));

    const busyButton = await screen.findByRole("button", { name: /loading/i });
    expect(busyButton).toBeDisabled();
    const calls = vi.mocked(getVpsAiConversation).mock.calls;
    expect(calls).toHaveLength(3);
    // The request covers exactly the unread window [0, oldestMessageOffset).
    expect(calls[2]?.[1]).toBe(conversation.id);
    expect(calls[2]?.[3]).toBe(0);
    expect(calls[2]?.[4]).toBe(150);

    // The server echoes the boundary message already on screen (overlap);
    // it must end up rendered exactly once overall.
    const boundaryEcho = pageOf(150, 1).messages;
    await act(async () => {
      olderPage.resolve({
        ...pageOf(0, 150),
        messages: [...pageOf(0, 150).messages, ...boundaryEcho],
      });
    });

    const chat = getChatLog();
    await waitFor(() => {
      expect(within(chat).getByText("Paged message 0")).toBeInTheDocument();
    });
    expect(within(chat).getAllByText("Paged message 150")).toHaveLength(1);
    expect(within(chat).getAllByRole("article")).toHaveLength(350);
    // Offset 0 reached: no older window remains.
    await waitFor(() => {
      expect(screen.queryByRole("button", { name: /load older messages/i })).toBeNull();
    });
  });

  it("pages through successive older windows down to the conversation start, including a partial final page", async () => {
    const { pageOf } = setupWindowedConversationHost(450);
    vi.mocked(getVpsAiConversation).mockImplementation(
      async (_vpsId, _conversationId, _signal, offset = 0, limit = 200) =>
        pageOf(offset, limit),
    );

    renderPanel();
    await screen.findByText("Paged message 449");
    let chat = getChatLog();
    expect(within(chat).queryByText("Paged message 249")).toBeNull();
    expect(within(chat).getAllByRole("article")).toHaveLength(200);

    // Second window: [50, 250).
    fireEvent.click(screen.getByRole("button", { name: /load older messages/i }));
    expect(await screen.findByText("Paged message 50")).toBeInTheDocument();
    chat = getChatLog();
    expect(within(chat).queryByText("Paged message 49")).toBeNull();
    expect(within(chat).getAllByRole("article")).toHaveLength(400);
    expect(
      screen.getByRole("button", { name: /load older messages/i }),
    ).toBeInTheDocument();

    // Final partial window: [0, 50) exhausts the history.
    fireEvent.click(screen.getByRole("button", { name: /load older messages/i }));
    expect(await screen.findByText("Paged message 0")).toBeInTheDocument();
    chat = getChatLog();
    expect(within(chat).getAllByRole("article")).toHaveLength(450);
    await waitFor(() => {
      expect(screen.queryByRole("button", { name: /load older messages/i })).toBeNull();
    });

    const windows = vi.mocked(getVpsAiConversation).mock.calls.map((call) => [
      call[3] ?? 0,
      call[4] ?? 200,
    ]);
    expect(windows).toEqual([
      [0, 1], // total probe
      [250, 200], // latest window (450 - 200)
      [50, 200], // older window 1
      [0, 50], // older window 2 (partial)
    ]);
  });
});

describe("AssistantPanel selection and reset races", () => {
  it("keeps a New Chat empty when a superseded history selection resolves late", async () => {
    const { conversationA, conversationB } = setupTwoConversationHost(
      "Session A",
      "Session B",
    );
    const messagesA = makeLabeledMessages(conversationA.id, "Session A", 3);
    const messagesB = makeLabeledMessages(conversationB.id, "Session B", 3);
    const lateSelectionPage = deferred<AiConversationDetail>();
    vi.mocked(getVpsAiConversation).mockImplementation(
      async (_vpsId, conversationId, _signal, offset = 0, limit = 200) => {
        if (conversationId === conversationA.id) {
          return {
            conversation: conversationA,
            messages: messagesA,
            total: messagesA.length,
          };
        }
        // Session B: the 1-message probe resolves immediately; the full
        // page is held back so "New Chat" can supersede it mid-flight.
        if (limit === 1) {
          return {
            conversation: conversationB,
            messages: messagesB.slice(-1),
            total: messagesB.length,
          };
        }
        return lateSelectionPage.promise;
      },
    );

    renderPanel();
    await screen.findByText("Session A message 3");

    fireEvent.click(screen.getByRole("button", { name: /^history$/i }));
    fireEvent.click(screen.getByRole("button", { name: /session b/i }));
    // Both Session B requests (probe + page) started before the reset.
    await waitFor(() => {
      expect(
        vi.mocked(getVpsAiConversation).mock.calls.filter(
          (call) => call[1] === conversationB.id,
        ),
      ).toHaveLength(2);
    });

    // Supersede the in-flight selection with an explicit New Chat reset.
    fireEvent.click(screen.getByRole("button", { name: /new chat/i }));
    expect(await screen.findByText(/how can the assistant help\?/i)).toBeInTheDocument();

    await act(async () => {
      lateSelectionPage.resolve({
        conversation: conversationB,
        messages: messagesB,
        total: messagesB.length,
      });
    });

    // The late page must not resurrect Session B into the empty new chat.
    expect(screen.getByText(/how can the assistant help\?/i)).toBeInTheDocument();
    const chat = getChatLog();
    expect(within(chat).queryByText("Session B message 1")).toBeNull();
    expect(within(chat).queryByText("Session A message 3")).toBeNull();
  });

  it("does not prepend a late older page into a different conversation selected mid-flight", async () => {
    const { conversationA, conversationB } = setupTwoConversationHost(
      "Paged Session",
      "Session B",
    );
    const messagesA = makeWindowedMessages(conversationA.id, 350);
    const messagesB = makeLabeledMessages(conversationB.id, "Session B", 3);
    const lateOlderPage = deferred<AiConversationDetail>();
    vi.mocked(getVpsAiConversation).mockImplementation(
      async (_vpsId, conversationId, _signal, offset = 0, limit = 200) => {
        if (conversationId === conversationA.id) {
          if (offset === 0 && limit === 1) {
            return {
              conversation: conversationA,
              messages: messagesA.slice(0, 1),
              total: messagesA.length,
            };
          }
          // Older window for Session A stays in flight across the switch.
          if (offset === 0 && limit === 150) {
            return lateOlderPage.promise;
          }
          return {
            conversation: conversationA,
            messages: messagesA.slice(offset, offset + limit),
            total: messagesA.length,
          };
        }
        return {
          conversation: conversationB,
          messages: messagesB,
          total: messagesB.length,
        };
      },
    );

    renderPanel();
    await screen.findByText("Paged message 349");
    expect(within(getChatLog()).queryByText("Paged message 149")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: /load older messages/i }));
    expect(await screen.findByRole("button", { name: /loading/i })).toBeDisabled();

    // Switch to another conversation while the older page is in flight.
    fireEvent.click(screen.getByRole("button", { name: /^history$/i }));
    fireEvent.click(screen.getByRole("button", { name: /session b/i }));
    await screen.findByText("Session B message 3");

    await act(async () => {
      lateOlderPage.resolve({
        conversation: conversationA,
        messages: messagesA.slice(0, 150),
        total: messagesA.length,
      });
    });

    // Session A's late page must neither prepend into Session B nor
    // resurface the pager for a conversation without an older window.
    const chat = getChatLog();
    expect(within(chat).queryByText("Paged message 0")).toBeNull();
    expect(within(chat).queryByText("Paged message 349")).toBeNull();
    expect(within(chat).getByText("Session B message 3")).toBeInTheDocument();
    expect(within(chat).getAllByRole("article")).toHaveLength(3);
    expect(screen.queryByRole("button", { name: /load older messages/i })).toBeNull();
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
    expect(code, "expected a <code> element for `inline code` text").not.toBeNull();
    expect(code?.textContent).toBe("docker ps --filter name=nginx");
  });
});

describe("AssistantPanel multi-provider model selection", () => {
  const alpha = makeProfile({
    id: "prov-a",
    name: "Alpha",
    models: ["a-1", "a-2"],
    defaultModel: "a-1",
  });
  const beta = makeProfile({
    id: "prov-b",
    name: "Beta",
    models: ["b-1"],
    defaultModel: "b-1",
    isDefault: false,
  });
  const offline = makeProfile({
    id: "prov-off",
    name: "Offline",
    models: ["off-1"],
    defaultModel: "off-1",
    enabled: false,
    isDefault: false,
  });

  function mockSend(request: string) {
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
  }

  function modelSelect(): HTMLSelectElement {
    return screen.getByRole("combobox", { name: /model/i }) as HTMLSelectElement;
  }

  it("initializes the model selector from the admin's last used selection", async () => {
    mockAssistantLoaded({ tasks: [], conversationDetail: null });
    vi.mocked(listAiProviders).mockResolvedValue(
      makeProvidersResponse([alpha, beta], { providerId: "prov-b", model: "b-1" }),
    );

    renderPanel();

    await screen.findByRole("combobox", { name: /model/i });
    await waitFor(() => {
      expect(modelSelect()).toHaveValue("prov-b::b-1");
    });
  });

  it("prefers the conversation's provider pin over the last selection when it resolves", async () => {
    mockAssistantLoaded({
      tasks: [],
      conversationDetail: {
        conversation: makeConversation({
          selectedProviderId: "prov-a",
          selectedModel: "a-2",
        }),
        messages: [],
      },
    });
    vi.mocked(listAiProviders).mockResolvedValue(
      makeProvidersResponse([alpha, beta], { providerId: "prov-b", model: "b-1" }),
    );

    renderPanel();

    await screen.findByRole("combobox", { name: /model/i });
    await waitFor(() => {
      expect(modelSelect()).toHaveValue("prov-a::a-2");
    });
  });

  it("falls back to the default enabled profile when the last selection is stale", async () => {
    const request = "Summarize host health";
    mockAssistantLoaded({ tasks: [], conversationDetail: null });
    vi.mocked(listAiProviders).mockResolvedValue(
      makeProvidersResponse([alpha, offline], {
        providerId: "prov-off",
        model: "off-1",
      }),
    );
    mockSend(request);

    renderPanel();

    await screen.findByRole("combobox", { name: /model/i });
    await waitFor(() => {
      expect(modelSelect()).toHaveValue("prov-a::a-1");
    });

    fireEvent.change(screen.getByPlaceholderText(/ask the assistant/i), {
      target: { value: request },
    });
    fireEvent.click(screen.getByRole("button", { name: /send/i }));

    await waitFor(() => {
      expect(createVpsAiTask).toHaveBeenCalledWith("vps-1", {
        request,
        idempotencyKey: expect.any(String),
        conversationId: undefined,
        providerId: "prov-a",
        model: "a-1",
      });
    });
  });

  it("omits the provider binding from the send when the selection is stale and no default exists", async () => {
    const request = "Rotate the tls certificates";
    mockAssistantLoaded({ tasks: [], conversationDetail: null });
    vi.mocked(listAiProviders).mockResolvedValue(
      makeProvidersResponse([offline], {
        providerId: "prov-off",
        model: "off-1",
      }),
    );
    mockSend(request);

    renderPanel();
    await screen.findByText(/how can the assistant help\?/i);

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
  });
});

describe("AssistantPanel selection-pin warning", () => {
  const alpha = makeProfile({
    id: "prov-a",
    name: "Alpha",
    models: ["a-1", "a-2"],
    defaultModel: "a-1",
  });
  const offline = makeProfile({
    id: "prov-off",
    name: "Offline",
    models: ["off-1"],
    defaultModel: "off-1",
    enabled: false,
    isDefault: false,
  });

  it("warns when the active conversation is pinned to a disabled provider and lets the operator dismiss it", async () => {
    mockAssistantLoaded({
      tasks: [],
      conversationDetail: {
        conversation: makeConversation({
          selectedProviderId: "prov-off",
          selectedModel: "off-1",
        }),
        messages: [makeMessage()],
      },
    });
    vi.mocked(listAiProviders).mockResolvedValue(
      makeProvidersResponse([alpha, offline], {
        providerId: "prov-a",
        model: "a-1",
      }),
    );

    renderPanel();
    await screen.findByText("Please prune unused docker images");

    expect(await screen.findByText(/disabled or removed/i)).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /dismiss/i }));
    expect(screen.queryByText(/disabled or removed/i)).toBeNull();
  });

  it("retires the pin warning when the operator picks another model", async () => {
    mockAssistantLoaded({
      tasks: [],
      conversationDetail: {
        conversation: makeConversation({
          selectedProviderId: "prov-off",
          selectedModel: "off-1",
        }),
        messages: [makeMessage()],
      },
    });
    vi.mocked(listAiProviders).mockResolvedValue(
      makeProvidersResponse([alpha, offline], {
        providerId: "prov-a",
        model: "a-1",
      }),
    );

    renderPanel();
    await screen.findByText("Please prune unused docker images");
    expect(await screen.findByText(/disabled or removed/i)).toBeInTheDocument();

    fireEvent.change(screen.getByRole("combobox", { name: /model/i }), {
      target: { value: "prov-a::a-2" },
    });

    expect(screen.queryByText(/disabled or removed/i)).toBeNull();
    expect(screen.getByRole("combobox", { name: /model/i })).toHaveValue("prov-a::a-2");
  });

  it("warns when the pinned model is no longer available on its provider", async () => {
    mockAssistantLoaded({
      tasks: [],
      conversationDetail: {
        conversation: makeConversation({
          selectedProviderId: "prov-a",
          selectedModel: "ghost-model",
        }),
        messages: [makeMessage()],
      },
    });
    vi.mocked(listAiProviders).mockResolvedValue(makeProvidersResponse([alpha]));

    renderPanel();
    await screen.findByText("Please prune unused docker images");

    expect(await screen.findByText(/no longer available/i)).toBeInTheDocument();
  });

  it("shows no pin warning for a conversation whose selection still resolves", async () => {
    mockAssistantLoaded({
      tasks: [],
      conversationDetail: {
        conversation: makeConversation({
          selectedProviderId: "prov-a",
          selectedModel: "a-2",
        }),
        messages: [makeMessage()],
      },
    });
    vi.mocked(listAiProviders).mockResolvedValue(makeProvidersResponse([alpha]));

    renderPanel();
    await screen.findByText("Please prune unused docker images");

    await waitFor(() => {
      expect(screen.getByRole("combobox", { name: /model/i })).toHaveValue("prov-a::a-2");
    });
    expect(screen.queryByText(/disabled or removed/i)).toBeNull();
    expect(screen.queryByText(/no longer available/i)).toBeNull();
  });
});

