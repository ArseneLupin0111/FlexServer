import { randomUUID } from "node:crypto";

export type TerminalLimits = {
  global: number;
  perDashboard: number;
  perVps: number;
};
export type TerminalRegistration = {
  id: string;
  dashboardId: string;
  vpsId: string;
  close: (reason: string) => Promise<void>;
};

export class TerminalSessionRegistry {
  private readonly sessions = new Map<string, TerminalRegistration>();
  constructor(
    private readonly limits: TerminalLimits = {
      global: 10,
      perDashboard: 3,
      perVps: 2,
    },
  ) {}
  admit(
    dashboardId: string,
    vpsId: string,
    close: (reason: string) => Promise<void>,
  ): TerminalRegistration {
    const all = [...this.sessions.values()];
    if (
      all.length >= this.limits.global ||
      all.filter((x) => x.dashboardId === dashboardId).length >=
        this.limits.perDashboard ||
      all.filter((x) => x.vpsId === vpsId).length >= this.limits.perVps
    )
      throw new Error("SESSION_LIMIT_REACHED");
    const registration = {
      id: `term_${randomUUID()}`,
      dashboardId,
      vpsId,
      close,
    };
    this.sessions.set(registration.id, registration);
    return registration;
  }
  release(id: string) {
    return this.sessions.delete(id);
  }
  hasActive(vpsId: string): boolean {
    for (const session of this.sessions.values()) {
      if (session.vpsId === vpsId) return true;
    }
    return false;
  }
  async closeByDashboard(id: string) {
    await this.closeMatching((x) => x.dashboardId === id, "session_expired");
  }
  async closeByDashboardSession(id: string) {
    await this.closeByDashboard(id);
  }
  async closeByVps(id: string) {
    await this.closeMatching((x) => x.vpsId === id, "vps_unavailable");
  }
  async closeAll(reason = "server_shutdown") {
    await this.closeMatching(() => true, reason);
  }
  private async closeMatching(
    predicate: (session: TerminalRegistration) => boolean,
    reason: string,
  ) {
    const matches = [...this.sessions.values()].filter(predicate);
    await Promise.allSettled(
      matches.map(async (session) => {
        try {
          await session.close(reason);
        } finally {
          this.sessions.delete(session.id);
        }
      }),
    );
  }
  get size() {
    return this.sessions.size;
  }
}
