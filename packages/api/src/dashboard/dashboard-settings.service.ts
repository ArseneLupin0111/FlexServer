import {
  BadRequestException,
  Inject,
  Injectable,
  Optional,
} from "@nestjs/common";
import { z } from "zod";
import { APP_CONFIG, SETTINGS_REPOSITORY } from "../tokens.js";
import type { AppConfig } from "../config/app-config.js";
import type { SettingsRepository } from "../persistence/repositories/settings.repository.js";
import { AuditService } from "../audit/audit.service.js";

export const updateDashboardSettingsSchema = z
  .object({
    webTerminalEnabled: z.boolean(),
  })
  .strict();

export type UpdateDashboardSettingsInput = z.infer<
  typeof updateDashboardSettingsSchema
>;

@Injectable()
export class DashboardSettingsService {
  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(SETTINGS_REPOSITORY)
    private readonly settingsRepo: SettingsRepository,
    @Optional() private readonly audit?: AuditService,
  ) {}
  private readonly disabledListeners: Array<() => Promise<void> | void> = [];

  onDisabled(listener: () => Promise<void> | void): () => void {
    this.disabledListeners.push(listener);
    return () => {
      const idx = this.disabledListeners.indexOf(listener);
      if (idx !== -1) this.disabledListeners.splice(idx, 1);
    };
  }

  private validateOriginPrerequisites(): boolean {
    if (!this.config.dashboardPublicOrigin) {
      return false;
    }
    try {
      const origin = new URL(this.config.dashboardPublicOrigin);
      if (
        !["http:", "https:"].includes(origin.protocol) ||
        origin.pathname !== "/" ||
        origin.search ||
        origin.hash ||
        origin.username ||
        origin.password
      ) {
        return false;
      }
    } catch {
      return false;
    }
    if (
      this.config.dashboardPublicOrigin.startsWith("https://") &&
      !this.config.dashboardCookieSecure
    ) {
      return false;
    }
    return true;
  }

  /**
   * Returns the effective web terminal enabled state.
   * If not explicitly persisted, falls back to config.enableWebTerminal.
   * In demo mode or non-local modes or if origin prerequisites fail,
   * web terminal is strictly disabled (fails closed).
   */
  async isWebTerminalEnabled(): Promise<boolean> {
    if (this.config.mode !== "local") {
      return false;
    }
    if (!this.validateOriginPrerequisites()) {
      return false;
    }
    const persisted = await this.settingsRepo.get();
    if (persisted && typeof persisted.webTerminalEnabled === "boolean") {
      return persisted.webTerminalEnabled;
    }
    return Boolean(this.config.enableWebTerminal);
  }

  /**
   * Persists runtime settings.
   * Enabling web terminal requires local app mode and a configured canonical DASHBOARD_PUBLIC_ORIGIN.
   */
  async updateSettings(
    input: unknown,
    actor = "dashboard",
  ): Promise<{ webTerminalEnabled: boolean }> {
    const parseResult = updateDashboardSettingsSchema.safeParse(input);
    if (!parseResult.success) {
      throw new BadRequestException(
        parseResult.error.issues.map((i) => i.message).join(", ") ||
          "Invalid settings payload.",
      );
    }
    const { webTerminalEnabled } = parseResult.data;

    if (webTerminalEnabled) {
      if (this.config.mode !== "local") {
        throw new BadRequestException(
          "Web terminal is only available in local mode.",
        );
      }

      if (!this.config.dashboardPublicOrigin) {
        throw new BadRequestException(
          "Cannot enable web terminal: DASHBOARD_PUBLIC_ORIGIN is not configured. Set DASHBOARD_PUBLIC_ORIGIN in your environment or settings.",
        );
      }

      try {
        const origin = new URL(this.config.dashboardPublicOrigin);
        if (
          !["http:", "https:"].includes(origin.protocol) ||
          origin.pathname !== "/" ||
          origin.search ||
          origin.hash ||
          origin.username ||
          origin.password
        ) {
          throw new Error("Invalid origin structure");
        }
      } catch {
        throw new BadRequestException(
          "Cannot enable web terminal: DASHBOARD_PUBLIC_ORIGIN must be a canonical origin (e.g. https://dashboard.example.com).",
        );
      }

      if (
        this.config.dashboardPublicOrigin.startsWith("https://") &&
        !this.config.dashboardCookieSecure
      ) {
        throw new BadRequestException(
          "Cannot enable web terminal: DASHBOARD_COOKIE_SECURE=true is required when DASHBOARD_PUBLIC_ORIGIN uses https://.",
        );
      }
    }

    const updated = await this.settingsRepo.upsert({
      webTerminalEnabled,
    });

    if (!updated.webTerminalEnabled) {
      await Promise.allSettled(this.disabledListeners.map((listener) => listener()));
    }

    try {
      await this.audit?.record({
        actor,
        action: "settings.web_terminal.update",
        resourceType: "dashboard",
        result: "success",
        metadata: {
          webTerminalEnabled: updated.webTerminalEnabled,
        },
      });
    } catch {}

    return {
      webTerminalEnabled: updated.webTerminalEnabled ?? false,
    };
  }
}
