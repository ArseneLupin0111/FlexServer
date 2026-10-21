import "../../../../test/setup";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useComposeApplications } from "./useComposeApplications";
import * as composeApi from "../../../../lib/compose-applications";
import type {
  ComposeAppSummary,
  ComposeCapability,
} from "../../../../lib/compose-applications";
vi.mock("../../../../lib/compose-applications", () => ({
  getVpsComposeCapability: vi.fn(),
  listVpsComposeApplications: vi.fn(),
}));
const capability: ComposeCapability = {
  supported: true,
  runtime: { dockerPresent: true },
  agent: {},
  inventory: { completeness: true },
  admission: { ready: true, reasons: [] },
  demoDisabled: false,
};

afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});

type ApplicationsPage = Awaited<ReturnType<typeof composeApi.listVpsComposeApplications>>;

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function item(id: string): ComposeAppSummary {
  return {
    appId: id,
    displayName: id,
    projectName: id,
    mode: "detected_readonly",
    observed: { services: [] },
  };
}

function page(items: ComposeAppSummary[], nextCursor?: string): ApplicationsPage {
  return { items, nextCursor };
}

describe("useComposeApplications", () => {
  it("does not append a deferred old-VPS page after switching VPS", async () => {
    const oldMore = deferred<ApplicationsPage>();
    const capabilityCall = vi.mocked(composeApi.getVpsComposeCapability);
    const listCall = vi.mocked(composeApi.listVpsComposeApplications);
    capabilityCall.mockResolvedValue(capability);
    listCall.mockImplementation((vpsId, cursor) => {
      if (vpsId === "old" && cursor === "stub-cursor") return oldMore.promise;
      return Promise.resolve(page([item(vpsId)], "stub-cursor"));
    });

    const { result, rerender } = renderHook(({ vpsId }) => useComposeApplications(vpsId, 0), {
      initialProps: { vpsId: "old" },
    });
    await waitFor(() => expect(result.current.applications).toEqual([item("old")]));
    await act(async () => {
      result.current.loadMore();
    });
    await waitFor(() => expect(result.current.loadingMore).toBe(true));

    rerender({ vpsId: "new" });
    await waitFor(() => expect(result.current.applications).toEqual([item("new")]));
    await act(async () => oldMore.resolve(page([item("stale")])));

    expect(result.current.applications).toEqual([item("new")]);
  });

  it("retains existing evidence when a same-VPS refresh fails", async () => {
    const capabilityCall = vi.mocked(composeApi.getVpsComposeCapability);
    const listCall = vi.mocked(composeApi.listVpsComposeApplications);
    capabilityCall.mockResolvedValue(capability);
    listCall.mockResolvedValueOnce(page([item("present")], "next"));
    const { result, rerender } = renderHook(
      ({ refreshTick }) => useComposeApplications("vps", refreshTick),
      { initialProps: { refreshTick: 0 } },
    );
    await waitFor(() => expect(result.current.applications).toEqual([item("present")]));

    listCall.mockRejectedValueOnce(new Error("refresh failed"));
    capabilityCall.mockRejectedValueOnce(new Error("capability failed"));
    rerender({ refreshTick: 1 });

    await waitFor(() => expect(result.current.error).toBe("refresh failed"));
    expect(result.current.capability).toEqual(capability);
    expect(result.current.applications).toEqual([item("present")]);
    expect(result.current.nextCursor).toBe("next");
  });

  it("clears prior capability and items when switching VPS", async () => {
    const capabilityCall = vi.mocked(composeApi.getVpsComposeCapability);
    const listCall = vi.mocked(composeApi.listVpsComposeApplications);
    const nextCapability = deferred<ComposeCapability>();
    const nextPage = deferred<ApplicationsPage>();
    capabilityCall
      .mockResolvedValueOnce(capability)
      .mockReturnValueOnce(nextCapability.promise);
    listCall
      .mockResolvedValueOnce(page([item("old")], "old-next"))
      .mockReturnValueOnce(nextPage.promise);
    const { result, rerender } = renderHook(({ vpsId }) => useComposeApplications(vpsId, 0), {
      initialProps: { vpsId: "old" },
    });
    await waitFor(() => expect(result.current.applications).toEqual([item("old")]));

    rerender({ vpsId: "new" });
    await waitFor(() => {
      expect(result.current.capability).toBeNull();
      expect(result.current.applications).toEqual([]);
      expect(result.current.nextCursor).toBeUndefined();
    });

    await act(async () => {
      nextCapability.resolve(capability);
      nextPage.resolve(page([item("new")]));
    });
    await waitFor(() => expect(result.current.applications).toEqual([item("new")]));
    expect(result.current.capability).toEqual(capability);
  });
});
