import { ConflictException, Injectable } from "@nestjs/common";
export type ActivityKind = "job" | "terminal" | "ai" | "docker" | "compose" | "files" | "sftp";
export type LifecycleOperation =
  | "install"
  | "uninstall"
  | "upgrade"
  | "restart"
  | "rotate"
  | "update"
  | "provision"
  | "reconcile";

type Slot = {
  lifecycle?: LifecycleOperation;
  ingests: number;
  waiters: Array<() => void>;
  activities: Record<string, number>;
};

@Injectable()
export class AgentLifecycleCoordinator {
  private readonly slots = new Map<string, Slot>();
  private slot(id: string): Slot {
    let s = this.slots.get(id);
    if (!s) {
      s = {
        ingests: 0,
        waiters: [],
        activities: { job: 0, terminal: 0, ai: 0, docker: 0, compose: 0, files: 0, sftp: 0 },
      };
      this.slots.set(id, s);
    }
    return s;
  }

  async tryAcquire(
    vpsId: string,
    operation: LifecycleOperation,
  ): Promise<() => void> {
    const s = this.slot(vpsId);
    if (s.lifecycle)
      throw new ConflictException(
        "An agent lifecycle operation is already in progress for this VPS",
      );
    const hasActivities = Object.values(s.activities).some((c) => (c ?? 0) > 0);
    if (
      operation === "update" &&
      hasActivities
    ) {
      throw new ConflictException(
        "Cannot perform agent update while activity is in progress for this VPS",
      );
    }
    s.lifecycle = operation;
    if ((operation === "uninstall" || operation === "reconcile") && s.ingests) {
      const { promise, resolve } = Promise.withResolvers<void>();
      s.waiters.push(resolve);
      await promise;
    }
    let released = false;
    return () => {
      if (released) return;
      released = true;
      s.lifecycle = undefined;
      this.drain(vpsId, s);
    };
  }
  tryAcquireActivity(vpsId: string, kind: ActivityKind): () => void {
    const s = this.slot(vpsId);
    if (s.lifecycle === "update") {
      throw new ConflictException(
        "Agent update is in progress for this VPS",
      );
    }
    s.activities[kind] = (s.activities[kind] ?? 0) + 1;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      s.activities[kind] = Math.max(0, (s.activities[kind] ?? 0) - 1);
      this.drain(vpsId, s);
    };
  }

  async beginIngest(vpsId: string): Promise<() => void> {
    const s = this.slot(vpsId);
    if (s.lifecycle === "uninstall" || s.lifecycle === "reconcile")
      throw new ConflictException("Agent lifecycle operation in progress");
    s.ingests++;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      s.ingests--;
      this.drain(vpsId, s);
    };
  }
  private drain(id: string, s: Slot) {
    if (s.ingests === 0) {
      for (const w of s.waiters.splice(0)) w();
    }
    if (
      !s.lifecycle &&
      s.ingests === 0 &&
      s.waiters.length === 0 &&
      !Object.values(s.activities).some((c) => (c ?? 0) > 0)
    )
      this.slots.delete(id);
  }
  isLifecycleActive(id: string) {
    return Boolean(this.slot(id).lifecycle);
  }
  isUninstalling(id: string) {
    return this.slot(id).lifecycle === "uninstall";
  }
}
