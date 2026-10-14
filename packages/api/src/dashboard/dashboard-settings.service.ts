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
    webTerminalEnabled: z.boolean().optional(),
    terminalCommandGuardEnabled: z.boolean().optional(),
  })
  .strict()
  .refine(
    (data) =>
      data.webTerminalEnabled !== undefined ||
      data.terminalCommandGuardEnabled !== undefined,
    {
      message: "At least one setting must be provided.",
    },
  );

export type UpdateDashboardSettingsInput = z.infer<
  typeof updateDashboardSettingsSchema
>;

export type DashboardSettingsResponse = {
  webTerminalEnabled: boolean;
  terminalCommandGuardEnabled: boolean;
};

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
    return this.getEffectiveWebTerminalConfigDefault();
  }

  getEffectiveWebTerminalConfigDefault(): boolean {
    if (this.config.mode !== "local") {
      return false;
    }
    if (!this.validateOriginPrerequisites()) {
      return false;
    }
    return Boolean(this.config.enableWebTerminal);
  }

  /**
   * Returns the effective terminal command guard enabled state.
   * If not explicitly persisted, defaults to false.
   * In demo mode or non-local modes, command guard is strictly disabled.
   */
  async isTerminalCommandGuardEnabled(): Promise<boolean> {
    if (this.config.mode !== "local") {
      return false;
    }
    const persisted = await this.settingsRepo.get();
    if (
      persisted &&
      typeof persisted.terminalCommandGuardEnabled === "boolean"
    ) {
      return persisted.terminalCommandGuardEnabled;
    }
    return false;
  }

  /**
   * Persists runtime settings.
   * Enabling web terminal requires local app mode and a configured canonical DASHBOARD_PUBLIC_ORIGIN.
   */
  async updateSettings(
    input: unknown,
    actor = "dashboard",
  ): Promise<DashboardSettingsResponse> {
    const parseResult = updateDashboardSettingsSchema.safeParse(input);
    if (!parseResult.success) {
      throw new BadRequestException(
        parseResult.error.issues.map((i) => i.message).join(", ") ||
          "Invalid settings payload.",
      );
    }
    const { webTerminalEnabled, terminalCommandGuardEnabled } =
      parseResult.data;

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

    if (terminalCommandGuardEnabled) {
      if (this.config.mode !== "local") {
        throw new BadRequestException(
          "Terminal command guard is only available in local mode.",
        );
      }
    }

    const updated = await this.settingsRepo.upsert(
      {
        webTerminalEnabled,
        terminalCommandGuardEnabled,
      },
      {
        webTerminalEnabled: this.getEffectiveWebTerminalConfigDefault(),
        terminalCommandGuardEnabled: false,
      },
    );

    if (webTerminalEnabled === false) {
      await Promise.allSettled(
        this.disabledListeners.map((listener) => listener()),
      );
    }

    try {
      const action =
        webTerminalEnabled !== undefined &&
        terminalCommandGuardEnabled === undefined
          ? "settings.web_terminal.update"
          : terminalCommandGuardEnabled !== undefined &&
              webTerminalEnabled === undefined
            ? "settings.terminal_command_guard.update"
            : "settings.update";

      await this.audit?.record({
        actor,
        action,
        resourceType: "dashboard",
        result: "success",
        metadata: {
          ...(webTerminalEnabled !== undefined
            ? { webTerminalEnabled: updated.webTerminalEnabled }
            : {}),
          ...(terminalCommandGuardEnabled !== undefined
            ? {
                terminalCommandGuardEnabled:
                  updated.terminalCommandGuardEnabled,
              }
            : {}),
        },
      });
    } catch {}

    return {
      webTerminalEnabled: updated.webTerminalEnabled ?? false,
      terminalCommandGuardEnabled:
        updated.terminalCommandGuardEnabled ?? false,
    };
  }
}
