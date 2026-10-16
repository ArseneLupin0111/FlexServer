import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { DockerMetricsPanel, dockerSnapshotState } from "./DockerMetricsPanel";
import type { DashboardDockerContainerMetric, DashboardDockerMetrics, VpsRecord } from "../../../lib/api";

const vps = { id: "vps-1", name: "web-01", host: "example.test", port: 22, username: "root", dockerMetricsEnabled: true, createdAt: "", updatedAt: "" } as VpsRecord;
const container = (name: string, image: string, state = "running", cpuPercent = 1, memoryUsageBytes = 1024): DashboardDockerContainerMetric => ({ containerKey: name, name, image, state, status: state, cpuPercent, memoryUsageBytes, networkRxBytes: 0, networkTxBytes: 0, blockReadBytes: 0, blockWriteBytes: 0, pids: 1 });
const metric = (overrides: Partial<DashboardDockerMetrics> = {}): DashboardDockerMetrics => ({ vpsId: "vps-1", collectedAt: "2026-01-01T00:00:00Z", receivedAt: new Date().toISOString(), agentInstanceId: "agent-1", snapshotId: "snapshot-1", sourceSequence: "1", schemaVersion: 2, available: true, containerTotal: 1, containerRunning: 1, cpuPercent: 1, memoryUsageBytes: 1024, networkRxBytes: 0, networkTxBytes: 0, blockReadBytes: 0, blockWriteBytes: 0, pids: 1, containers: [container("api", "app:latest")], ...overrides });
const view = (dockerMetrics?: DashboardDockerMetrics, record = vps, presentation: "compact" | "detail" = "detail") => render(<DockerMetricsPanel vps={record} dockerMetrics={dockerMetrics} busy={false} onToggle={vi.fn()} presentation={presentation} />, { wrapper: MemoryRouter });

afterEach(cleanup);

describe("DockerMetricsPanel freshness", () => {
  it("derives missing freshness with conservative 120 second semantics", () => {
    const now = Date.parse("2026-06-01T12:00:00Z");
    expect(dockerSnapshotState(metric({ freshness: undefined, receivedAt: new Date(now - 119_999).toISOString() }), now)).toBe("live");
    expect(dockerSnapshotState(metric({ freshness: undefined, receivedAt: new Date(now - 120_000).toISOString() }), now)).toBe("stale");
    expect(dockerSnapshotState(metric({ freshness: undefined, receivedAt: "2026-06-01T11:57:59Z" }), now)).toBe("stale");
    expect(dockerSnapshotState(metric({ freshness: undefined, receivedAt: "2026-06-01T12:00:01Z" }), now)).toBe("unknown");
    expect(dockerSnapshotState(metric({ freshness: undefined, receivedAt: "invalid" }), now)).toBe("unknown");
    expect(dockerSnapshotState(metric({ freshness: undefined, receivedAt: "" }), now)).toBe("unknown");
  });
  it("never labels an old legacy snapshot live", () => { view(metric({ freshness: undefined, receivedAt: "2020-01-01T00:00:00Z" })); expect(screen.getByText("Saved snapshot · not live")).toBeInTheDocument(); expect(screen.queryByText("Live snapshot")).not.toBeInTheDocument(); });
  it("labels future, invalid, and missing legacy timestamps unknown and not live", () => { const { rerender } = view(metric({ freshness: undefined, receivedAt: "2999-01-01T00:00:00Z" })); expect(screen.getByText(/freshness unknown · not live/)).toBeInTheDocument(); rerender(<DockerMetricsPanel vps={vps} dockerMetrics={metric({ freshness: undefined, receivedAt: "invalid" })} busy={false} onToggle={vi.fn()} presentation="detail" />); expect(screen.getByText(/freshness unknown · not live/)).toBeInTheDocument(); rerender(<DockerMetricsPanel vps={vps} dockerMetrics={metric({ freshness: undefined, receivedAt: "" })} busy={false} onToggle={vi.fn()} presentation="detail" />); expect(screen.getByText(/freshness unknown · not live/)).toBeInTheDocument(); expect(screen.queryByText("Live snapshot")).not.toBeInTheDocument(); });
});

describe("DockerMetricsPanel details", () => {
  it("uses authoritative totals and scopes search to retained details", () => { view(metric({ freshness: "stale", containerTotal: 27, containers: [container("api", "app:latest"), container("worker", "jobs:latest", "exited")] })); expect(screen.getByText("Showing 2 detail rows of 27 reported containers")).toBeInTheDocument(); expect(screen.getByText(/Search and filters cover 2 retained detail rows; 25 reported containers/)).toBeInTheDocument(); fireEvent.change(screen.getByRole("searchbox"), { target: { value: "api" } }); expect(screen.getByText("1 matches in details")).toBeInTheDocument(); });
  it("filters unhealthy containers and sorts CPU descending", () => { view(metric({ freshness: "fresh", containerTotal: 3, containers: [container("low", "a", "running", 1), container("broken", "b", "running", 2), container("high", "c", "running", 9)] })); fireEvent.change(screen.getByLabelText("Sort containers"), { target: { value: "cpu" } }); const rows = screen.getAllByRole("listitem"); expect(within(rows[0]).getByText("high")).toBeInTheDocument(); fireEvent.change(screen.getByLabelText("Filter containers"), { target: { value: "unhealthy" } }); expect(screen.getByText("No containers match this view.")).toBeInTheDocument(); });
  it("shows friendly known and unknown errors and preserves privacy copy", () => { const unavailable = metric({ available: false, errorCode: "permission_denied", containers: [] }); const { rerender } = view(unavailable); expect(screen.getByText(/does not have permission/)).toBeInTheDocument(); rerender(<DockerMetricsPanel vps={vps} dockerMetrics={metric({ available: false, errorCode: "new_error", containers: [] })} busy={false} onToggle={vi.fn()} />); expect(screen.getByText("Docker metrics are unavailable right now.")).toBeInTheDocument(); rerender(<DockerMetricsPanel vps={{ ...vps, dockerMetricsEnabled: false }} busy={false} onToggle={vi.fn()} />); fireEvent.click(screen.getByRole("button", { name: /Enable Docker metrics/ })); expect(screen.getByText(/Environment variables, logs, mounts, labels, and commands are not collected/)).toBeInTheDocument(); });
  it("uses the expanded server-detail hierarchy and shows eight rows initially", () => {
    const containers = Array.from({ length: 10 }, (_, index) => container(`service-${index}`, "app:latest"));
    render(<MemoryRouter><DockerMetricsPanel vps={vps} dockerMetrics={metric({ containerTotal: 10, containers })} busy={false} onToggle={vi.fn()} presentation="detail" /></MemoryRouter>);
    expect(screen.getByText("Showing 8 detail rows of 10 reported containers")).toBeInTheDocument();
    expect(screen.getAllByRole("listitem")).toHaveLength(8);
    fireEvent.click(screen.getByRole("button", { name: /Show more/ }));
    expect(screen.getAllByRole("listitem")).toHaveLength(10);
    expect(screen.getByRole("button", { name: /Show less/ })).toHaveAttribute("aria-expanded", "true");
  });
  it("navigates compact users to the server Docker tab instead of expanding inline", () => {
    const containers = Array.from({ length: 5 }, (_, index) => container(`service-${index}`, "app:latest"));
    render(<MemoryRouter initialEntries={["/vps"]}><Routes><Route path="/vps" element={<DockerMetricsPanel vps={vps} dockerMetrics={metric({ containerTotal: 5, containers })} busy={false} onToggle={vi.fn()} />} /><Route path="/vps/:vpsId/docker" element={<p>Dedicated Docker page</p>} /></Routes></MemoryRouter>);
    expect(screen.getAllByRole("listitem")).toHaveLength(3);
    const link = screen.getByRole("link", { name: "View Docker details for web-01" });
    expect(link).toHaveAttribute("href", "/vps/vps-1/docker");
    fireEvent.click(link);
    expect(screen.getByText("Dedicated Docker page")).toBeInTheDocument();
  });
  it("keeps compact cards free of detail controls and snapshot status copy", () => {
    view(metric({ freshness: "stale", containers: [container("api", "app:latest"), container("worker", "jobs:latest")] }), vps, "compact");
    expect(screen.queryByRole("searchbox")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Filter containers")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Sort containers")).not.toBeInTheDocument();
    expect(screen.queryByText(/Saved snapshot/i)).not.toBeInTheDocument();
    expect(screen.getByLabelText("Container health summary")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "View Docker details for web-01" })).toBeInTheDocument();
  });
  it("retains freshness status and functional controls in detail mode", () => {
    view(metric({ freshness: "stale", containers: [container("api", "app:latest"), container("worker", "jobs:latest", "exited")] }));
    expect(screen.getByText("Saved snapshot · not live")).toBeInTheDocument();
    expect(screen.getByRole("searchbox")).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Filter containers"), { target: { value: "stopped" } });
    expect(screen.getAllByRole("listitem")).toHaveLength(1);
    expect(screen.getByText("worker")).toBeInTheDocument();
  });
});

describe("DockerMetricsPanel container detail links", () => {
  const detailView = (dockerMetrics: DashboardDockerMetrics) => {
    render(
      <MemoryRouter initialEntries={["/vps/vps-1/docker"]}>
        <Routes>
          <Route
            path="/vps/:vpsId/docker"
            element={
              <DockerMetricsPanel
                vps={vps}
                dockerMetrics={dockerMetrics}
                busy={false}
                onToggle={vi.fn()}
                presentation="detail"
              />
            }
          />
          <Route
            path="/vps/:vpsId/docker/containers/:agentInstanceId/:containerKey"
            element={<p>Container detail page</p>}
          />
        </Routes>
      </MemoryRouter>,
    );
  };

  it("links each container to its own detail route with agent instance identity", () => {
    detailView(
      metric({
        containers: [
          container("api", "app:latest"),
          container("worker", "jobs:latest"),
        ],
      }),
    );

    const apiLink = screen.getByRole("link", {
      name: "View details for container api",
    });
    expect(apiLink).toHaveAttribute(
      "href",
      "/vps/vps-1/docker/containers/agent-1/api",
    );
    const workerLink = screen.getByRole("link", {
      name: "View details for container worker",
    });
    expect(workerLink).toHaveAttribute(
      "href",
      "/vps/vps-1/docker/containers/agent-1/worker",
    );
  });

  it("navigates to the container detail page on click", () => {
    detailView(metric({ containers: [container("api", "app:latest")] }));

    fireEvent.click(
      screen.getByRole("link", { name: "View details for container api" }),
    );
    expect(screen.getByText("Container detail page")).toBeInTheDocument();
  });

  it("omits the detail link when the agent instance is unknown", () => {
    detailView(
      metric({
        agentInstanceId: "",
        containers: [container("api", "app:latest")],
      }),
    );

    expect(
      screen.queryByRole("link", { name: "View details for container api" }),
    ).not.toBeInTheDocument();
    expect(screen.getByText("api")).toBeInTheDocument();
  });

  it("links compact rows too, not only expanded detail rows", () => {
    render(
      <MemoryRouter initialEntries={["/vps"]}>
        <Routes>
          <Route
            path="/vps"
            element={
              <DockerMetricsPanel
                vps={vps}
                dockerMetrics={metric({
                  containers: [container("api", "app:latest")],
                })}
                busy={false}
                onToggle={vi.fn()}
                presentation="compact"
              />
            }
          />
          <Route
            path="/vps/:vpsId/docker/containers/:agentInstanceId/:containerKey"
            element={<p>Container detail page</p>}
          />
        </Routes>
      </MemoryRouter>,
    );

    const link = screen.getByRole("link", {
      name: "View details for container api",
    });
    expect(link).toHaveAttribute(
      "href",
      "/vps/vps-1/docker/containers/agent-1/api",
    );
    fireEvent.click(link);
    expect(screen.getByText("Container detail page")).toBeInTheDocument();
  });
});
