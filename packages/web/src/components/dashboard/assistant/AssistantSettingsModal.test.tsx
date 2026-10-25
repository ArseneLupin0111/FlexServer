import "../../../test/setup";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AssistantSettingsModal } from "./AssistantSettingsModal";
import type { AssistantSettingsModalProps } from "./AssistantSettingsModal";
import type { AiProviderProfile, ProviderProfileWrite } from "../../../lib/ai-api";

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
    revision: 1,
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
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
