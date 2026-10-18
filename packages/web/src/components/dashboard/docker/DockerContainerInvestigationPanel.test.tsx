import "../../../test/setup";
import { cleanup, render, screen, waitFor, fireEvent } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DockerPage, DockerCurrentContainer, DockerOperationalEvent } from "../../../lib/api";
import { listVpsDockerEvents } from "../../../lib/api";
import { DockerContainerInvestigationPanel } from "./DockerContainerInvestigationPanel";

vi.mock("../../../lib/api", async (load) => {
  const actual = await load<typeof import("../../../lib/api")>();
  return { ...actual, listVpsDockerEvents: vi.fn() };
});
vi.mock("./DockerContainerManagementPanel", () => ({ DockerContainerManagementPanel: () => <div>Logs and controls</div> }));
afterEach(() => { cleanup(); vi.clearAllMocks(); });

const container: DockerCurrentContainer = {
  agentInstanceId: "agent-a", containerKey: "opaque-a", name: "worker-a", state: "exited", image: "alpine:3.20",
  metrics: { cpuPercent: 0, memoryUsageBytes: 0, pids: 0 }, collectedAt: "2026-10-19T12:00:00Z",
  details: { collectedAt: "2026-10-19T11:59:00Z", status: "available", exitCode: 7, oomKilled: false, ports: [], mounts: [], networks: [], healthcheck: { status: "none" } },
};
function event(id: string, additions: Partial<DockerOperationalEvent> = {}): DockerOperationalEvent {
  return { id, vpsId: "vps-a", agentInstanceId: "agent-a", containerKey: "opaque-a", action: "die", eventOccurredAt: "2026-10-19T11:00:00Z", receivedAt: "2026-10-19T11:00:00Z", eventDigest: id, contextVersion: 1, ...additions };
}
function response(data: DockerOperationalEvent[], cursor?: string, hasMore = false): DockerPage<DockerOperationalEvent> {
  return { data, page: { limit: 25, ...(cursor ? { nextCursor: cursor } : {}), hasMore } };
}
const props = { vpsId: "vps-a", container, managementEnabled: false, monitoringEnabled: true, refreshTick: 0 };

describe("DockerContainerInvestigationPanel", () => {
  it("shows explicit false OOM, unknown OOM, and no healthcheck without inferring values", async () => {
    vi.mocked(listVpsDockerEvents).mockResolvedValue(response([event("1", { oomKilled: false, signal: 9, healthStatus: "unhealthy" })]));
    const { rerender } = render(<DockerContainerInvestigationPanel {...props} />);
    expect(await screen.findByText("No", { selector: "dd" })).toBeInTheDocument();
    expect(screen.getByText("No healthcheck configured")).toBeInTheDocument();
    expect(await screen.findByText(/OOM killed No · health unhealthy/)).toBeInTheDocument();
    const missing = { ...container, details: { collectedAt: container.details!.collectedAt, status: "available" as const, oomKilled: undefined, ports: [], mounts: [], networks: [], healthcheck: { status: "none" as const } } };
    rerender(<DockerContainerInvestigationPanel {...props} container={missing} />);
    expect(screen.getByText("Unknown", { selector: "dd" })).toBeInTheDocument();
  });

  it("shows missing details separately from unavailable and empty inspected details", () => {
    const withoutDetails = { ...container, details: undefined };
    const { rerender } = render(<DockerContainerInvestigationPanel {...props} container={withoutDetails} monitoringEnabled={false} />);
    expect(screen.getByText(/has not been supplied by this agent/i)).toBeInTheDocument();
    expect(listVpsDockerEvents).not.toHaveBeenCalled();
    rerender(<DockerContainerInvestigationPanel {...props} container={container} monitoringEnabled={false} />);
    expect(screen.getByText("No ports reported.")).toBeInTheDocument();
    expect(screen.getByText("No mounts reported.")).toBeInTheDocument();
    expect(screen.getByText("No networks reported.")).toBeInTheDocument();
  });

  it("scopes the 25-event query, pages with cursor, deduplicates, and caps at 100", async () => {
    vi.mocked(listVpsDockerEvents).mockResolvedValueOnce(response(Array.from({ length: 25 }, (_, i) => event(String(i))), "cursor-a", true));
    vi.mocked(listVpsDockerEvents).mockResolvedValueOnce(response([event("24"), ...Array.from({ length: 25 }, (_, i) => event(String(25 + i)))], "cursor-b", true));
    render(<DockerContainerInvestigationPanel {...props} />);
    await screen.findByText(/25 loaded events/);
    expect(listVpsDockerEvents).toHaveBeenCalledWith("vps-a", { agentInstanceId: "agent-a", containerKey: "opaque-a", limit: 25 });
    fireEvent.click(screen.getByRole("button", { name: "Load more events" }));
    await waitFor(() => expect(screen.getByText(/50 loaded events/)).toBeInTheDocument());
    expect(listVpsDockerEvents).toHaveBeenLastCalledWith("vps-a", { agentInstanceId: "agent-a", containerKey: "opaque-a", limit: 25, cursor: "cursor-a" });
  });

  it("ignores a late result after the selected identity changes", async () => {
    let resolvePending!: (page: DockerPage<DockerOperationalEvent>) => void;
    const pending = new Promise<DockerPage<DockerOperationalEvent>>((resolve) => { resolvePending = resolve; });
    vi.mocked(listVpsDockerEvents).mockImplementationOnce(() => pending);
    vi.mocked(listVpsDockerEvents).mockResolvedValueOnce(response([event("new-event")]));
    const { rerender } = render(<DockerContainerInvestigationPanel {...props} />);
    rerender(<DockerContainerInvestigationPanel {...props} container={{ ...container, agentInstanceId: "agent-b", containerKey: "opaque-b" }} />);
    await waitFor(() => expect(listVpsDockerEvents).toHaveBeenCalledTimes(2));
    resolvePending(response([event("stale-event")]));
    await waitFor(() => expect(screen.queryByText(/stale-event/)).not.toBeInTheDocument());
    expect(screen.queryByText(/new-event/)).not.toBeInTheDocument();
  });

  it("caps the retained recent event window at 100 entries", async () => {
    vi.mocked(listVpsDockerEvents).mockResolvedValueOnce(response(Array.from({ length: 25 }, (_, index) => event(`event-${index}`)), "cursor-1", true));
    vi.mocked(listVpsDockerEvents).mockResolvedValueOnce(response(Array.from({ length: 25 }, (_, index) => event(`event-${25 + index}`)), "cursor-2", true));
    vi.mocked(listVpsDockerEvents).mockResolvedValueOnce(response(Array.from({ length: 25 }, (_, index) => event(`event-${50 + index}`)), "cursor-3", true));
    vi.mocked(listVpsDockerEvents).mockResolvedValueOnce(response(Array.from({ length: 25 }, (_, index) => event(`event-${75 + index}`)), "cursor-4", true));
    render(<DockerContainerInvestigationPanel {...props} />);
    for (let page = 0; page < 3; page += 1) {
      fireEvent.click(await screen.findByRole("button", { name: "Load more events" }));
      await waitFor(() => expect(screen.getByText(new RegExp(`${(page + 2) * 25} loaded events`))).toBeInTheDocument());
    }
    expect(screen.getByText(/Only the 100 most recent loaded events are shown/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Load more events" })).not.toBeInTheDocument();
  });

  it("retains events on load-more failure and retries initial errors; unavailable and disabled states are explicit", async () => {
    vi.mocked(listVpsDockerEvents).mockResolvedValueOnce(response([event("kept")], "cursor-a", true));
    vi.mocked(listVpsDockerEvents).mockRejectedValueOnce(new Error("page failed"));
    const unavailable: DockerCurrentContainer = { ...container, details: { collectedAt: container.collectedAt, status: "unavailable", reason: "timeout" } };
    const { rerender } = render(<DockerContainerInvestigationPanel {...props} container={unavailable} />);
    expect(await screen.findByText(/details were unavailable.*timeout/i)).toBeInTheDocument();
    expect(await screen.findByText("Container exited")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Load more events" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("page failed");
    expect(screen.getByText("Container exited")).toBeInTheDocument();
    rerender(<DockerContainerInvestigationPanel {...props} container={unavailable} monitoringEnabled={false} />);
    expect(screen.getAllByText(/Docker monitoring is disabled/).length).toBeGreaterThan(0);
  });
  it("shows an initial event error and retries the scoped query", async () => {
    vi.mocked(listVpsDockerEvents).mockRejectedValueOnce(new Error("request failed"));
    vi.mocked(listVpsDockerEvents).mockResolvedValueOnce(response([]));
    render(<DockerContainerInvestigationPanel {...props} />);
    expect(await screen.findByText("Operational Docker events are unavailable right now.")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(listVpsDockerEvents).toHaveBeenCalledTimes(2));
  });
});
