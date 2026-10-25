import "../../../test/setup";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { afterEach, describe, expect, it, vi, type MockInstance } from "vitest";
import { AssistantSettingsModal } from "./AssistantSettingsModal";
import type { AssistantSettingsModalProps } from "./AssistantSettingsModal";
import type {
  AiPolicy,
  AiProviderProfile,
  ProviderProfileWrite,
  UpdateAiPolicy,
} from "../../../lib/ai-api";

function makeProfile(overrides: Partial<AiProviderProfile> = {}): AiProviderProfile {
  return {
    id: "prov-1",
    name: "Primary",
    endpoint: "https://primary.example/v1",
    models: ["gpt-4o", "o4-mini"],
    defaultModel: "gpt-4o",
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

function makeOauthProfile(
  overrides: Partial<AiProviderProfile> = {},
): AiProviderProfile {
  return makeProfile({
    id: "prov-oauth",
    name: "ChatGPT",
    endpoint: "https://chatgpt.com/backend-api/codex/responses",
    models: ["gpt-5-codex", "gpt-5.1-codex"],
    defaultModel: "gpt-5-codex",
    hasApiKey: false,
    authKind: "chatgpt_oauth",
    isDefault: false,
    ...overrides,
  });
}

type ModalOverrides = Partial<AssistantSettingsModalProps>;

function renderModal(providers: AiProviderProfile[] = [makeProfile()], overrides: ModalOverrides = {}) {
  const mocks = {
    onClose: vi.fn(),
    onCreateProvider: vi.fn().mockResolvedValue(undefined),
    onUpdateProvider: vi.fn().mockResolvedValue(undefined),
    onDeleteProvider: vi.fn().mockResolvedValue(undefined),
    onCheckProviderProfile: vi.fn().mockResolvedValue(undefined),
    onFetchProviderModels: vi.fn().mockResolvedValue(undefined),
    onAuthorizeProviderOauth: vi.fn().mockResolvedValue("https://auth.openai.com/authorize?state=s1"),
    onExchangeProviderOauth: vi.fn().mockResolvedValue({
      expiresAt: "2026-01-01T05:00:00.000Z",
      lastRefreshedAt: "2026-01-01T00:00:00.000Z",
    }),
    onSavePolicy: vi.fn().mockResolvedValue(undefined),
  };
  const props: AssistantSettingsModalProps = {
    open: true,
    vpsId: "vps-1",
    providers,
    policy: null,
    capability: null,
    ...mocks,
    ...overrides,
  };
  const view = render(<AssistantSettingsModal {...props} />);
  return { view, props, mocks };
}

function profileRow(profile: AiProviderProfile): HTMLElement {
  const row = document.querySelector(`[data-provider-id="${profile.id}"]`);
  expect(row, `expected a profile row for ${profile.id}`).not.toBeNull();
  return row as HTMLElement;
}

function rowButton(row: HTMLElement, name: RegExp | string): HTMLButtonElement {
  return within(row).getByRole("button", { name });
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("AssistantSettingsModal profile list", () => {
  it("renders one row per profile with endpoint, badges, and model count", () => {
    const providers = [
      makeProfile(),
      makeProfile({
        id: "prov-2",
        name: "Backup",
        endpoint: "https://backup.example/v1",
        models: ["b-1"],
        defaultModel: "b-1",
        enabled: false,
        isDefault: false,
        hasApiKey: false,
      }),
    ];
    renderModal(providers);

    const primary = profileRow(providers[0]);
    expect(within(primary).getByText("Primary")).toBeInTheDocument();
    expect(within(primary).getByText("https://primary.example/v1")).toBeInTheDocument();
    expect(within(primary).getByText("Default")).toBeInTheDocument();
    // The count shares a node with the default-model suffix.
    expect(within(primary).getByText(/2 models/)).toBeInTheDocument();
    expect(within(primary).queryByText("Disabled")).toBeNull();
    expect(within(primary).queryByText("No key")).toBeNull();

    const backup = profileRow(providers[1]);
    expect(within(backup).getByText("Backup")).toBeInTheDocument();
    expect(within(backup).getByText("Disabled")).toBeInTheDocument();
    expect(within(backup).getByText("No key")).toBeInTheDocument();
    expect(within(backup).getByText(/1 model/)).toBeInTheDocument();
    expect(within(backup).queryByText("Default")).toBeNull();
  });

  it("disables Check and Fetch for profiles without a saved API key", () => {
    const providers = [
      makeProfile(),
      makeProfile({ id: "prov-2", name: "Keyless", hasApiKey: false, isDefault: false }),
    ];
    renderModal(providers);

    expect(rowButton(profileRow(providers[0]), /check provider primary/i)).toBeEnabled();
    expect(rowButton(profileRow(providers[0]), /fetch models for primary/i)).toBeEnabled();
    expect(rowButton(profileRow(providers[1]), /check provider keyless/i)).toBeDisabled();
    expect(rowButton(profileRow(providers[1]), /fetch models for keyless/i)).toBeDisabled();
  });

  it("shows an empty-state hint when no profiles exist", () => {
    renderModal([]);
    expect(screen.getByText(/no provider profiles yet/i)).toBeInTheDocument();
  });
});

describe("AssistantSettingsModal per-profile check", () => {
  it("runs the check against the saved profile row and shows a green result", async () => {
    const { props } = renderModal();
    const profile = props.providers[0];

    fireEvent.click(rowButton(profileRow(profile), /check provider primary/i));

    await waitFor(() => {
      expect(props.onCheckProviderProfile).toHaveBeenCalledWith("prov-1");
    });
    const row = profileRow(profile);
    await waitFor(() => {
      expect(within(row).getByText(/provider check succeeded/i)).toBeInTheDocument();
    });
    expect(within(row).queryByText(/provider check failed/i)).toBeNull();
  });

  it("shows the failure message and no false green when the check rejects", async () => {
    const { props } = renderModal([makeProfile()], {
      onCheckProviderProfile: vi.fn().mockRejectedValue(new Error("401 invalid api key")),
    });
    const profile = props.providers[0];

    fireEvent.click(rowButton(profileRow(profile), /check provider primary/i));

    const row = profileRow(profile);
    await waitFor(() => {
      expect(within(row).getByText(/401 invalid api key/i)).toBeInTheDocument();
    });
    expect(within(row).queryByText(/provider check succeeded/i)).toBeNull();
  });

  it("does not repaint a green result when the providers prop refreshes while the check is pending", async () => {
    let resolveCheck!: () => void;
    const { props, view } = renderModal([makeProfile()], {
      onCheckProviderProfile: vi.fn().mockImplementation(
        () =>
          new Promise<void>((resolve) => {
            resolveCheck = resolve;
          }),
      ),
    });

    fireEvent.click(rowButton(profileRow(props.providers[0]), /check provider primary/i));
    await waitFor(() => {
      expect(props.onCheckProviderProfile).toHaveBeenCalledTimes(1);
    });

    // Parent delivers a newer profile list (same content) while in flight.
    view.rerender(
      <AssistantSettingsModal
        {...props}
        providers={[makeProfile({ revision: 2, updatedAt: "2026-01-02T00:00:00.000Z" })]}
      />,
    );

    await act(async () => {
      resolveCheck();
    });

    expect(screen.queryByText(/provider check succeeded/i)).toBeNull();
  });
});

describe("AssistantSettingsModal add provider", () => {
  it("creates a profile with the drafted body, collapses the editor, and clears the key field", async () => {
    const { props } = renderModal();

    fireEvent.click(screen.getByRole("button", { name: /add provider/i }));
    expect(screen.getByRole("heading", { name: /new provider profile/i })).toBeInTheDocument();

    fireEvent.change(screen.getByPlaceholderText("Primary provider"), {
      target: { value: "Secondary" },
    });
    fireEvent.change(screen.getByPlaceholderText("https://api.openai.com"), {
      target: { value: "https://secondary.example/v1" },
    });
    fireEvent.change(screen.getByPlaceholderText(/enter provider api key/i), {
      target: { value: "sk-new-secret" },
    });
    fireEvent.change(screen.getByPlaceholderText(/gpt-4o\s+o4-mini/), {
      target: { value: "m-a\nm-b" },
    });
    // defaultModel left blank: must default to the first model.
    fireEvent.click(screen.getByRole("switch", { name: /set as default provider/i }));

    fireEvent.click(screen.getByRole("button", { name: /create provider/i }));

    await waitFor(() => {
      expect(props.onCreateProvider).toHaveBeenCalledTimes(1);
    });
    expect(props.onCreateProvider).toHaveBeenCalledWith({
      name: "Secondary",
      endpoint: "https://secondary.example/v1",
      apiKey: "sk-new-secret",
      allowPrivateEndpoint: false,
      models: ["m-a", "m-b"],
      defaultModel: "m-a",
      enabled: true,
      isDefault: true,
    } satisfies ProviderProfileWrite);

    // Editor collapses back to the list.
    expect(screen.queryByRole("heading", { name: /new provider profile/i })).toBeNull();

    // Reopening the editor must not resurrect the submitted key.
    fireEvent.click(screen.getByRole("button", { name: /add provider/i }));
    expect(
      screen.getByPlaceholderText(/enter provider api key/i),
    ).toHaveValue("");
  });

  it("rejects an incomplete draft client-side without calling create", async () => {
    const { props } = renderModal();

    fireEvent.click(screen.getByRole("button", { name: /add provider/i }));
    fireEvent.click(screen.getByRole("button", { name: /create provider/i }));

    expect(
      screen.getByText(/name, endpoint, and at least one model are required/i),
    ).toBeInTheDocument();
    expect(props.onCreateProvider).not.toHaveBeenCalled();
  });

  it("defaults a blank defaultModel to the first parsed model", async () => {
    const { props } = renderModal();

    fireEvent.click(screen.getByRole("button", { name: /add provider/i }));
    fireEvent.change(screen.getByPlaceholderText("Primary provider"), {
      target: { value: "Tiny" },
    });
    fireEvent.change(screen.getByPlaceholderText("https://api.openai.com"), {
      target: { value: "https://tiny.example/v1" },
    });
    fireEvent.change(screen.getByPlaceholderText(/gpt-4o\s+o4-mini/), {
      target: { value: "  only-model  \n\n" },
    });
    fireEvent.click(screen.getByRole("button", { name: /create provider/i }));

    await waitFor(() => {
      expect(props.onCreateProvider).toHaveBeenCalledWith(
        expect.objectContaining({ models: ["only-model"], defaultModel: "only-model" }),
      );
    });
  });
});

describe("AssistantSettingsModal edit provider", () => {
  it("prefills the editor and updates without an apiKey when the key field stays blank", async () => {
    const { props, mocks } = renderModal();

    fireEvent.click(rowButton(profileRow(props.providers[0]), /edit primary/i));
    expect(screen.getByRole("heading", { name: /edit profile: primary/i })).toBeInTheDocument();

    const keyField = screen.getByPlaceholderText(/leave blank to keep current/i);
    expect(keyField).toHaveValue("");

    fireEvent.change(screen.getByPlaceholderText("Primary provider"), {
      target: { value: "Primary renamed" },
    });
    fireEvent.click(screen.getByRole("button", { name: /save changes/i }));

    await waitFor(() => {
      expect(mocks.onUpdateProvider).toHaveBeenCalledTimes(1);
    });
    expect(mocks.onUpdateProvider).toHaveBeenCalledWith("prov-1", {
      name: "Primary renamed",
      endpoint: "https://primary.example/v1",
      allowPrivateEndpoint: false,
      models: ["gpt-4o", "o4-mini"],
      defaultModel: "gpt-4o",
      enabled: true,
      isDefault: true,
    } satisfies ProviderProfileWrite);
    const body = mocks.onUpdateProvider.mock.calls[0][1] as ProviderProfileWrite;
    expect(body.apiKey).toBeUndefined();
  });

  it("keeps the endpoint and models from the saved profile when only the key is drafted", async () => {
    const { props } = renderModal();

    fireEvent.click(rowButton(profileRow(props.providers[0]), /edit primary/i));
    fireEvent.change(screen.getByPlaceholderText(/leave blank to keep current/i), {
      target: { value: "sk-rotated" },
    });
    fireEvent.click(screen.getByRole("button", { name: /save changes/i }));

    await waitFor(() => {
      expect(props.onUpdateProvider).toHaveBeenCalledWith(
        "prov-1",
        expect.objectContaining({ apiKey: "sk-rotated" }),
      );
    });
  });
});

describe("AssistantSettingsModal delete provider", () => {
  it("requires a second confirming click before deleting", async () => {
    const { props } = renderModal();

    fireEvent.click(rowButton(profileRow(props.providers[0]), /delete provider primary/i));
    expect(props.onDeleteProvider).not.toHaveBeenCalled();
    expect(
      rowButton(profileRow(props.providers[0]), /confirm delete primary/i),
    ).toBeInTheDocument();

    fireEvent.click(rowButton(profileRow(props.providers[0]), /confirm delete primary/i));
    await waitFor(() => {
      expect(props.onDeleteProvider).toHaveBeenCalledWith("prov-1");
    });
  });

  it("surfaces the 409 conflict message when the profile is still referenced", async () => {
    const { props } = renderModal([makeProfile()], {
      onDeleteProvider: vi
        .fn()
        .mockRejectedValue(new Error("Provider profile is referenced by conversations")),
    });

    fireEvent.click(rowButton(profileRow(props.providers[0]), /delete provider primary/i));
    fireEvent.click(rowButton(profileRow(props.providers[0]), /confirm delete primary/i));

    await waitFor(() => {
      expect(
        screen.getByText(/provider profile is referenced by conversations/i),
      ).toBeInTheDocument();
    });
    expect(screen.queryByText(/provider profile deleted/i)).toBeNull();
  });
});

describe("AssistantSettingsModal enable/disable toggle", () => {
  it("updates the saved profile with the flipped enabled flag and no apiKey", async () => {
    const { props, mocks } = renderModal();

    fireEvent.click(rowButton(profileRow(props.providers[0]), /disable provider primary/i));

    await waitFor(() => {
      expect(mocks.onUpdateProvider).toHaveBeenCalledTimes(1);
    });
    expect(mocks.onUpdateProvider).toHaveBeenCalledWith("prov-1", {
      name: "Primary",
      endpoint: "https://primary.example/v1",
      allowPrivateEndpoint: false,
      models: ["gpt-4o", "o4-mini"],
      defaultModel: "gpt-4o",
      enabled: false,
      isDefault: true,
    } satisfies ProviderProfileWrite);
    const body = mocks.onUpdateProvider.mock.calls[0][1] as ProviderProfileWrite;
    expect(body.apiKey).toBeUndefined();
  });
});

// ── ChatGPT OAuth (docs/ai-chatgpt-oauth-provider-plan.md, Q10) ──────────

function oauthSection(id: string): HTMLElement {
  const section = document.querySelector(`[data-oauth-section="${id}"]`);
  expect(section, `expected an OAuth section for ${id}`).not.toBeNull();
  return section as HTMLElement;
}

async function revealPasteInput(
  props: AssistantSettingsModalProps,
  authorizeUrl = "https://auth.openai.com/authorize?client_id=app_x&state=s1",
): Promise<{ paste: HTMLElement; openSpy: MockInstance }> {
  const openSpy = vi.spyOn(window, "open").mockReturnValue(null);
  fireEvent.click(
    screen.getByRole("checkbox", { name: /i understand the oauth risk/i }),
  );
  fireEvent.click(
    screen.getByRole("button", { name: /open authorize url for chatgpt/i }),
  );
  await waitFor(() => {
    expect(props.onAuthorizeProviderOauth).toHaveBeenCalledWith("prov-oauth");
  });
  const paste = await screen.findByLabelText("OAuth callback URL");
  return { paste, openSpy };
}

describe("AssistantSettingsModal OAuth editor auth kind", () => {
  it("hides endpoint/key fields and prefills the Codex models when ChatGPT OAuth is chosen", async () => {
    const onCreateProvider = vi.fn().mockResolvedValue(undefined);
    renderModal([makeProfile()], { onCreateProvider });

    fireEvent.click(screen.getByRole("button", { name: /add provider/i }));
    expect(screen.getByPlaceholderText("https://api.openai.com")).toBeInTheDocument();
    expect(screen.getByPlaceholderText(/enter provider api key/i)).toBeInTheDocument();

    fireEvent.change(screen.getByPlaceholderText("Primary provider"), {
      target: { value: "Codex" },
    });
    fireEvent.change(screen.getByRole("combobox", { name: /auth kind/i }), {
      target: { value: "chatgpt_oauth" },
    });

    expect(screen.queryByPlaceholderText("https://api.openai.com")).toBeNull();
    expect(screen.queryByPlaceholderText(/enter provider api key/i)).toBeNull();
    expect(screen.getByPlaceholderText(/gpt-4o\s+o4-mini/)).toHaveValue(
      "gpt-5-codex\ngpt-5.1-codex",
    );

    fireEvent.click(screen.getByRole("button", { name: /create provider/i }));
    await waitFor(() => {
      expect(onCreateProvider).toHaveBeenCalledTimes(1);
    });
    // OAuth create omits endpoint/apiKey/allowPrivateEndpoint; the server
    // fills the fixed Codex endpoint.
    expect(onCreateProvider).toHaveBeenCalledWith({
      name: "Codex",
      models: ["gpt-5-codex", "gpt-5.1-codex"],
      defaultModel: "gpt-5-codex",
      enabled: true,
      isDefault: false,
      authKind: "chatgpt_oauth",
    } satisfies ProviderProfileWrite);
    const body = onCreateProvider.mock.calls[0][0] as ProviderProfileWrite;
    expect(body.endpoint).toBeUndefined();
    expect(body.apiKey).toBeUndefined();
    expect(body.allowPrivateEndpoint).toBeUndefined();
  });

  it("rejects an incomplete OAuth draft with the OAuth message and no endpoint requirement", async () => {
    const { props } = renderModal();

    fireEvent.click(screen.getByRole("button", { name: /add provider/i }));
    fireEvent.change(screen.getByRole("combobox", { name: /auth kind/i }), {
      target: { value: "chatgpt_oauth" },
    });
    fireEvent.click(screen.getByRole("button", { name: /create provider/i }));

    expect(
      screen.getByText(/name and at least one model are required/i),
    ).toBeInTheDocument();
    expect(props.onCreateProvider).not.toHaveBeenCalled();
  });

  it("keeps the auth kind fixed in edit mode and PATCHes an OAuth profile without key fields", async () => {
    const onUpdateProvider = vi.fn().mockResolvedValue(undefined);
    const { props } = renderModal([makeOauthProfile()], { onUpdateProvider });

    fireEvent.click(rowButton(profileRow(props.providers[0]), /edit chatgpt/i));
    const kindSelect = screen.getByRole("combobox", { name: /auth kind/i });
    expect(kindSelect).toBeDisabled();
    expect(kindSelect).toHaveValue("chatgpt_oauth");
    expect(screen.queryByPlaceholderText("https://api.openai.com")).toBeNull();
    expect(screen.queryByPlaceholderText(/enter provider api key/i)).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: /save changes/i }));
    await waitFor(() => {
      expect(onUpdateProvider).toHaveBeenCalledTimes(1);
    });
    expect(onUpdateProvider).toHaveBeenCalledWith("prov-oauth", {
      name: "ChatGPT",
      models: ["gpt-5-codex", "gpt-5.1-codex"],
      defaultModel: "gpt-5-codex",
      enabled: true,
      isDefault: false,
    } satisfies ProviderProfileWrite);
    const body = onUpdateProvider.mock.calls[0][1] as ProviderProfileWrite;
    expect(body.endpoint).toBeUndefined();
    expect(body.apiKey).toBeUndefined();
  });

  it("toggles an OAuth profile without endpoint/key fields", async () => {
    const { props } = renderModal([makeOauthProfile()]);

    fireEvent.click(
      rowButton(profileRow(props.providers[0]), /disable provider chatgpt/i),
    );

    await waitFor(() => {
      expect(props.onUpdateProvider).toHaveBeenCalledTimes(1);
    });
    expect(props.onUpdateProvider).toHaveBeenCalledWith("prov-oauth", {
      name: "ChatGPT",
      models: ["gpt-5-codex", "gpt-5.1-codex"],
      defaultModel: "gpt-5-codex",
      enabled: false,
      isDefault: false,
    } satisfies ProviderProfileWrite);
  });
});

describe("AssistantSettingsModal OAuth paste-back flow", () => {
  it("shows no OAuth section for apiKey-kind profiles", () => {
    renderModal([makeProfile()]);

    expect(document.querySelector('[data-oauth-section="prov-1"]')).toBeNull();
    expect(screen.queryByText(/violates openai's terms of service/i)).toBeNull();
    expect(
      screen.queryByRole("checkbox", { name: /i understand/i }),
    ).toBeNull();
  });

  it("gates the authorize button behind the per-profile ToS acknowledgment", () => {
    renderModal([makeOauthProfile()]);

    expect(
      screen.getByText(/violates openai's terms of service/i),
    ).toBeInTheDocument();
    const authorize = screen.getByRole("button", {
      name: /open authorize url for chatgpt/i,
    });
    expect(authorize).toBeDisabled();

    fireEvent.click(
      screen.getByRole("checkbox", { name: /i understand the oauth risk/i }),
    );
    expect(
      screen.getByRole("button", { name: /open authorize url for chatgpt/i }),
    ).toBeEnabled();
  });

  it("opens the authorize URL in a new tab and reveals the paste-back field", async () => {
    const authorizeUrl = "https://auth.openai.com/authorize?client_id=app_x&state=s1";
    const { props } = renderModal([makeOauthProfile()], {
      onAuthorizeProviderOauth: vi.fn().mockResolvedValue(authorizeUrl),
    });

    const { paste, openSpy } = await revealPasteInput(props, authorizeUrl);

    expect(openSpy).toHaveBeenCalledWith(authorizeUrl, "_blank", "noopener,noreferrer");
    expect(paste).toBeInTheDocument();
    expect(screen.getByText(/localhost:1455\/auth\/callback/i)).toBeInTheDocument();
    expect(screen.getByText(/connection error/i)).toBeInTheDocument();
  });

  it("exchanges the pasted callback URL and shows the connected token status", async () => {
    const expiresAt = "2026-01-01T05:00:00.000Z";
    const lastRefreshedAt = "2026-01-01T00:00:00.000Z";
    const { props } = renderModal([makeOauthProfile()], {
      onExchangeProviderOauth: vi.fn().mockResolvedValue({ expiresAt, lastRefreshedAt }),
    });

    const { paste } = await revealPasteInput(props);
    fireEvent.change(paste, {
      target: { value: "http://localhost:1455/auth/callback?code=abc&state=s1" },
    });
    fireEvent.click(
      screen.getByRole("button", { name: /connect oauth login for chatgpt/i }),
    );

    await waitFor(() => {
      expect(props.onExchangeProviderOauth).toHaveBeenCalledWith(
        "prov-oauth",
        "http://localhost:1455/auth/callback?code=abc&state=s1",
      );
    });

    const section = oauthSection("prov-oauth");
    expect(await within(section).findByText("Connected")).toBeInTheDocument();
    expect(within(section).getByText(/token expires/i)).toBeInTheDocument();
    expect(within(section).getByText(new Date(expiresAt).toLocaleString())).toBeInTheDocument();
    expect(within(section).getByText(new Date(lastRefreshedAt).toLocaleString())).toBeInTheDocument();
    // The paste-back step collapses once the exchange succeeded.
    expect(screen.queryByLabelText("OAuth callback URL")).toBeNull();
  });

  it("shows a client-side error for an invalid paste URL without calling exchange", async () => {
    const { props } = renderModal([makeOauthProfile()]);

    const { paste } = await revealPasteInput(props);
    fireEvent.change(paste, { target: { value: "not a callback url" } });
    fireEvent.click(
      screen.getByRole("button", { name: /connect oauth login for chatgpt/i }),
    );

    expect(await screen.findByRole("alert")).toBeInTheDocument();
    expect(screen.getByText(/paste the full callback url/i)).toBeInTheDocument();
    expect(props.onExchangeProviderOauth).not.toHaveBeenCalled();
  });

  it("surfaces a rejected exchange instead of reporting success", async () => {
    const { props } = renderModal([makeOauthProfile()], {
      onExchangeProviderOauth: vi.fn().mockRejectedValue(new Error("state mismatch")),
    });

    const { paste } = await revealPasteInput(props);
    fireEvent.change(paste, {
      target: { value: "http://localhost:1455/auth/callback?code=abc&state=bad" },
    });
    fireEvent.click(
      screen.getByRole("button", { name: /connect oauth login for chatgpt/i }),
    );

    expect(await screen.findByRole("alert")).toBeInTheDocument();
    expect(screen.getByText(/state mismatch/i)).toBeInTheDocument();
    expect(within(oauthSection("prov-oauth")).queryByText("Connected")).toBeNull();
  });

  it("marks a relogin_required profile and reruns the flow as Re-login", async () => {
    const { props } = renderModal([
      makeOauthProfile({ tokenState: "relogin_required" }),
    ]);

    const section = oauthSection("prov-oauth");
    expect(within(section).getByText("Relogin required")).toBeInTheDocument();
    // The relogin state highlights the OAuth section for a redo.
    expect(section.className).toContain("border-warn");
    expect(within(section).getByText(/re-run the oauth flow/i)).toBeInTheDocument();

    const relogin = within(section).getByRole("button", {
      name: /re-login for chatgpt/i,
    });
    expect(relogin).toHaveTextContent("Re-login");

    // Re-login reruns the same paste-back flow (steps b-c).
    fireEvent.click(
      screen.getByRole("checkbox", { name: /i understand the oauth risk/i }),
    );
    fireEvent.click(relogin);
    expect(await screen.findByLabelText("OAuth callback URL")).toBeInTheDocument();
    expect(props.onAuthorizeProviderOauth).toHaveBeenCalledWith("prov-oauth");
  });

  it("shows the connected badge for a connected token state without re-login highlighting", () => {
    renderModal([makeOauthProfile({ tokenState: "connected" })]);

    const section = oauthSection("prov-oauth");
    expect(within(section).getByText("Connected")).toBeInTheDocument();
    expect(within(section).queryByText("Relogin required")).toBeNull();
    expect(section.className).not.toContain("border-warn");
    expect(
      within(section).getByRole("button", { name: /open authorize url for chatgpt/i }),
    ).toBeInTheDocument();
  });
});

// ── Policy tab: shell toggle moved to the Settings Agent card (Q6) ───────

const modalPolicy: AiPolicy = {
  vpsId: "vps-1",
  aiEnabled: true,
  readEnabled: true,
  dockerActionsEnabled: true,
  composeActionsEnabled: false,
  shellEnabled: true,
  execMode: "sandbox",
  privilegedAcknowledgedAt: null,
  privilegedAcknowledgedBy: null,
  fileReadScopes: ["/var/log"],
  fileWriteScopes: [],
  serviceProfileIds: [],
  sendLogsToProvider: false,
  sendFilesToProvider: false,
  revision: 4,
  updatedAt: "2026-01-01T00:00:00.000Z",
};

describe("AssistantSettingsModal policy tab without the shell toggle", () => {
  it("no longer renders the shell execution toggle while other policy controls stay", () => {
    renderModal([makeProfile()], { policy: modalPolicy });

    fireEvent.click(screen.getByRole("button", { name: /permissions/i }));

    expect(
      screen.queryByRole("switch", { name: /shell execution tools/i }),
    ).toBeNull();
    expect(
      screen.getByRole("switch", { name: /read-only tools/i }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("switch", { name: /docker mutation tools/i }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("switch", { name: /compose mutation tools/i }),
    ).toBeInTheDocument();
  });

  it("omits shellEnabled from the policy PATCH so saving other fields cannot overwrite the Agent card value", async () => {
    const { mocks } = renderModal([makeProfile()], { policy: modalPolicy });

    fireEvent.click(screen.getByRole("button", { name: /permissions/i }));
    fireEvent.click(screen.getByRole("button", { name: /save permissions/i }));

    await waitFor(() => {
      expect(mocks.onSavePolicy).toHaveBeenCalledTimes(1);
    });
    const patch = mocks.onSavePolicy.mock.calls[0][0] as UpdateAiPolicy;
    expect("shellEnabled" in patch).toBe(false);
    expect(patch).toMatchObject({
      aiEnabled: true,
      readEnabled: true,
      dockerActionsEnabled: true,
      composeActionsEnabled: false,
    });
  });
});
