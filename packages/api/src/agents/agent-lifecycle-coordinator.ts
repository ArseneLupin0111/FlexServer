import { ConflictException, Injectable } from "@nestjs/common";
export type LifecycleOperation =
  "install" | "uninstall" | "upgrade" | "restart" | "rotate" | "update" | "provision";
type Slot = {
  lifecycle?: LifecycleOperation;
  ingests: number;
  waiters: Array<() => void>;
};

@Injectable()
export class AgentLifecycleCoordinator {
  private readonly slots = new Map<string, Slot>();
  private slot(id: string): Slot {
    let s = this.slots.get(id);
    if (!s) {
      s = { ingests: 0, waiters: [] };
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
    s.lifecycle = operation;
    if (operation === "uninstall" && s.ingests)
      await new Promise<void>((resolve) => s.waiters.push(resolve));
    let released = false;
    return () => {
      if (released) return;
      released = true;
      s.lifecycle = undefined;
      this.drain(vpsId, s);
    };
  }

  async beginIngest(vpsId: string): Promise<() => void> {
    const s = this.slot(vpsId);
    if (s.lifecycle === "uninstall")
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
    if (!s.lifecycle && s.ingests === 0 && s.waiters.length === 0)
      this.slots.delete(id);
  }
  isLifecycleActive(id: string) {
    return Boolean(this.slot(id).lifecycle);
  }
  isUninstalling(id: string) {
    return this.slot(id).lifecycle === "uninstall";
  }
}
