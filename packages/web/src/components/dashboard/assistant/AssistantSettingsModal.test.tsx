import "../../../test/setup";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AssistantSettingsModal } from "./AssistantSettingsModal";
import type { AssistantSettingsModalProps } from "./AssistantSettingsModal";
import type { AiProviderSettings } from "../../../lib/ai-api";

const savedSettings: AiProviderSettings = {
  endpoint: "https://provider.example",
  model: "test-model",
  hasApiKey: true,
  allowPrivateEndpoint: false,
  revision: 1,
  updatedAt: "2026-01-01T00:00:00.000Z",
};

const incompleteSettings: AiProviderSettings = {
  endpoint: "https://provider.example",
  model: "",
  hasApiKey: false,
  allowPrivateEndpoint: false,
  revision: 1,
  updatedAt: "2026-01-01T00:00:00.000Z",
};

function renderModal(
  providerSettings: AiProviderSettings = savedSettings,
  overrides?: {
    onCheckProvider?: ReturnType<typeof vi.fn>;
    onSaveProviderSettings?: ReturnType<typeof vi.fn>;
  },
) {
  const onCheckProvider = overrides?.onCheckProvider ?? vi.fn().mockResolvedValue(undefined);
  const onSaveProviderSettings =
    overrides?.onSaveProviderSettings ?? vi.fn().mockResolvedValue(undefined);

  render(
    <AssistantSettingsModal
      open
      onClose={vi.fn()}
      vpsId="vps-1"
      providerSettings={providerSettings}
      policy={null}
      capability={null}
      onSaveProviderSettings={onSaveProviderSettings}
      onSavePolicy={vi.fn().mockResolvedValue(undefined)}
      onCheckProvider={onCheckProvider}
    />,
  );

  return { onCheckProvider, onSaveProviderSettings };
}

function checkButton() {
  return screen.getByRole("button", { name: /check endpoint/i });
}

async function runSuccessfulCheck() {
  const onCheckProvider = vi.fn().mockResolvedValue(undefined);
  renderModal(savedSettings, { onCheckProvider });
  fireEvent.click(checkButton());
  await waitFor(() => {
    expect(screen.getByText(/synthetic tool check succeeded/i)).toBeInTheDocument();
  });
  return onCheckProvider;
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("AssistantSettingsModal check gating", () => {
  it("enables Check Endpoint and reports success when the draft matches the saved complete configuration", async () => {
    const { onCheckProvider } = renderModal();

    expect(checkButton()).toBeEnabled();

    fireEvent.click(checkButton());
    await waitFor(() => {
      expect(onCheckProvider).toHaveBeenCalledTimes(1);
    });
    await waitFor(() => {
      expect(screen.getByText(/synthetic tool check succeeded/i)).toBeInTheDocument();
    });
  });

  it("disables Check Endpoint while the endpoint draft differs from the saved settings", () => {
    const { onCheckProvider } = renderModal();

    fireEvent.change(screen.getByPlaceholderText("https://api.openai.com"), {
      target: { value: "https://other.example" },
    });

    expect(checkButton()).toBeDisabled();
    fireEvent.click(checkButton());
    expect(onCheckProvider).not.toHaveBeenCalled();
    expect(
      screen.getByText(/runs against the saved configuration/i),
    ).toBeInTheDocument();
  });

  it("disables Check Endpoint while the model draft differs from the saved settings", () => {
    renderModal();

    fireEvent.change(screen.getByPlaceholderText("gpt-4o"), {
      target: { value: "other-model" },
    });

    expect(checkButton()).toBeDisabled();
  });

  it("disables Check Endpoint while a draft API key is present", () => {
    renderModal();

    fireEvent.change(
      screen.getByPlaceholderText(/leave blank to keep current/i),
      { target: { value: "sk-draft-secret" } },
    );

    expect(checkButton()).toBeDisabled();
  });

  it("disables Check Endpoint while the private-endpoint toggle differs from the saved settings", () => {
    renderModal();

    fireEvent.click(screen.getByRole("switch", { name: /allow private endpoint/i }));

    expect(checkButton()).toBeDisabled();
  });

  it("disables Check Endpoint when the saved configuration is incomplete", () => {
    renderModal(incompleteSettings);

    expect(checkButton()).toBeDisabled();
    expect(
      screen.getByText(/complete saved configuration/i),
    ).toBeInTheDocument();
  });

  it("shows the failure message and no false green when the check callback rejects", async () => {
    const onCheckProvider = vi
      .fn()
      .mockRejectedValue(new Error("Synthetic tool check failed. Check endpoint and credentials."));
    renderModal(savedSettings, { onCheckProvider });

    fireEvent.click(checkButton());

    await waitFor(() => {
      expect(screen.getByText(/synthetic tool check failed/i)).toBeInTheDocument();
    });
    expect(screen.queryByText(/synthetic tool check succeeded/i)).toBeNull();
  });
});

describe("AssistantSettingsModal stale check results", () => {
  it("clears a green check result when the draft is edited", async () => {
    await runSuccessfulCheck();

    fireEvent.change(screen.getByPlaceholderText("https://api.openai.com"), {
      target: { value: "https://other.example" },
    });

    expect(screen.queryByText(/synthetic tool check succeeded/i)).toBeNull();
  });

  it("clears the check result when the settings are saved", async () => {
    const { onSaveProviderSettings } = renderModal();

    fireEvent.click(checkButton());
    await waitFor(() => {
      expect(screen.getByText(/synthetic tool check succeeded/i)).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole("button", { name: /update connection/i }));
    await waitFor(() => {
      expect(onSaveProviderSettings).toHaveBeenCalledTimes(1);
    });
    await waitFor(() => {
      expect(screen.getByText(/global provider settings updated successfully/i)).toBeInTheDocument();
    });

    expect(screen.queryByText(/synthetic tool check succeeded/i)).toBeNull();
  });

  it("does not restore a green result when a late check response lands after the draft was edited", async () => {
    let resolveCheck!: () => void;
    const onCheckProvider = vi.fn().mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          resolveCheck = resolve;
        }),
    );
    renderModal(savedSettings, { onCheckProvider });

    fireEvent.click(checkButton());
    await waitFor(() => {
      expect(onCheckProvider).toHaveBeenCalledTimes(1);
    });

    // Draft edited while the check is still in flight.
    fireEvent.change(screen.getByPlaceholderText("https://api.openai.com"), {
      target: { value: "https://other.example" },
    });

    // The late response must not repaint a stale green result.
    await act(async () => {
      resolveCheck();
    });

    expect(screen.queryByText(/synthetic tool check succeeded/i)).toBeNull();
    expect(checkButton()).toBeDisabled();
  });

  it("does not restore a green result when the saved settings prop changes while a check is pending", async () => {
    let resolveCheck!: () => void;
    const onCheckProvider = vi.fn().mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          resolveCheck = resolve;
        }),
    );
    const baseProps = (over: Partial<AssistantSettingsModalProps>): AssistantSettingsModalProps => ({
      open: true,
      onClose: vi.fn(),
      vpsId: "vps-1",
      providerSettings: savedSettings,
      policy: null,
      capability: null,
      onSaveProviderSettings: vi.fn().mockResolvedValue(undefined),
      onSavePolicy: vi.fn().mockResolvedValue(undefined),
      onCheckProvider,
      ...over,
    });

    const view = render(<AssistantSettingsModal {...baseProps({})} />);
    fireEvent.click(screen.getByRole("button", { name: /check endpoint/i }));
    await waitFor(() => {
      expect(onCheckProvider).toHaveBeenCalledTimes(1);
    });

    // Parent delivers a newer saved configuration while the check is pending.
    view.rerender(
      <AssistantSettingsModal
        {...baseProps({
          providerSettings: { ...savedSettings, endpoint: "https://v2.example", revision: 2 },
        })}
      />,
    );

    await act(async () => {
      resolveCheck();
    });

    expect(screen.queryByText(/synthetic tool check succeeded/i)).toBeNull();
  });

  it("does not restore a green result when the modal is closed and reopened while a check is pending", async () => {
    let resolveCheck!: () => void;
    const onCheckProvider = vi.fn().mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          resolveCheck = resolve;
        }),
    );
    const baseProps = (open: boolean): AssistantSettingsModalProps => ({
      open,
      onClose: vi.fn(),
      vpsId: "vps-1",
      providerSettings: savedSettings,
      policy: null,
      capability: null,
      onSaveProviderSettings: vi.fn().mockResolvedValue(undefined),
      onSavePolicy: vi.fn().mockResolvedValue(undefined),
      onCheckProvider,
    });

    const view = render(<AssistantSettingsModal {...baseProps(true)} />);
    fireEvent.click(screen.getByRole("button", { name: /check endpoint/i }));
    await waitFor(() => {
      expect(onCheckProvider).toHaveBeenCalledTimes(1);
    });

    view.rerender(<AssistantSettingsModal {...baseProps(false)} />);
    view.rerender(<AssistantSettingsModal {...baseProps(true)} />);

    await act(async () => {
      resolveCheck();
    });

    expect(screen.queryByText(/synthetic tool check succeeded/i)).toBeNull();
  });
});
