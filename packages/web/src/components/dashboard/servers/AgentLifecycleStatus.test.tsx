import { cleanup, render, screen } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter } from "react-router-dom";
import { AgentLifecycleStatus, localAgentLabel } from "./AgentLifecycleStatus";
import { ServerTable } from "./ServerTable";
import type { VpsRecord } from "../../../lib/api";

// The shared upgrade control has its own suite; this file only asserts the
// lifecycle labels beside it, so keep its network/SSE side effects out.
vi.mock("./LocalAgentUpdate", () => ({ LocalAgentUpdate: () => null }));

const base: VpsRecord = { id: "vps-1", name: "web-01", host: "example.test", port: 22, username: "root", createdAt: "", updatedAt: "" };
const local = (overrides: Partial<VpsRecord> = {}): VpsRecord => ({ ...base, kind: "local", managedBy: "system", ...overrides });
const ago = (ms: number) => new Date(Date.now() - ms).toISOString();

afterEach(cleanup);

const show = (vps: VpsRecord) => render(<AgentLifecycleStatus vps={vps} jobs={[]} compact />);

describe("local agent lifecycle labels follow the observed heartbeat", () => {
  it("reports a freshly seen local process as online instead of a not-installed placeholder", () => {
    show(local({ lastSeenAt: ago(30_000) }));
    expect(screen.getByText("Agent online")).toBeInTheDocument();
    expect(screen.queryByText("Agent not installed")).not.toBeInTheDocument();
  });

  it("keeps offline semantics when the local heartbeat is stale", () => {
    show(local({ lastSeenAt: ago(10 * 60_000) }));
    expect(screen.getByText("Agent offline")).toBeInTheDocument();
    expect(screen.queryByText("Agent not installed")).not.toBeInTheDocument();
  });

  it("stays unknown when the local record carries no observation", () => {
    show(local());
    expect(screen.getByText("Agent status unknown")).toBeInTheDocument();
    expect(screen.queryByText("Agent not installed")).not.toBeInTheDocument();
  });

  it("defers to an explicit observed status over record freshness", () => {
    show(local({ agentStatus: "offline", lastSeenAt: ago(30_000) }));
    expect(screen.getByText("Agent offline")).toBeInTheDocument();
  });

  it("preserves the remote not-installed placeholder", () => {
    show(base);
    expect(screen.getByText("Agent not installed")).toBeInTheDocument();
  });
});

describe("localAgentLabel freshness mapping", () => {
  const now = Date.parse("2026-06-01T12:00:00Z");
  it("mirrors the API freshness window", () => {
    expect(localAgentLabel(new Date(now - 119_999).toISOString(), now)).toBe("Online");
    expect(localAgentLabel(new Date(now - 120_000).toISOString(), now)).toBe("Offline");
    expect(localAgentLabel(new Date(now + 60_000).toISOString(), now)).toBe("Unknown");
    expect(localAgentLabel("invalid", now)).toBe("Unknown");
    expect(localAgentLabel(undefined, now)).toBe("Unknown");
    expect(localAgentLabel("", now)).toBe("Unknown");
  });
});

describe("ServerTable local agent cell", () => {
  it("routes the local row through the observed label instead of the Unknown placeholder", () => {
    const remote: VpsRecord = { ...base, id: "vps-2", name: "remote-01" };
    render(
      <MemoryRouter>
        <ServerTable
          vpsList={[local({ lastSeenAt: ago(30_000), status: "healthy" }), remote]}
          busy={false}
          provisionPasswords={{}}
          onProvision={vi.fn()}
          onVerify={vi.fn()}
          onInstallAgent={vi.fn()}
          onUninstallAgent={vi.fn()}
          onRestartAgent={vi.fn()}
          onRotateAgent={vi.fn()}
          jobs={[]}
          onDelete={vi.fn()}
          mode="local"
          onEdit={vi.fn()}
        />
      </MemoryRouter>,
    );
    expect(screen.getByLabelText("Agent status: Online")).toBeInTheDocument();
    expect(screen.getByLabelText("Agent status: Not installed")).toBeInTheDocument();
    expect(screen.queryByLabelText("Agent status: Unknown")).not.toBeInTheDocument();
  });
});
