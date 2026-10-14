import { readJsonFile, writeJsonFile, withFileLock } from "./json-file.js";

export type SettingsRecord = {
  id: string;
  webTerminalEnabled?: boolean;
  terminalCommandGuardEnabled?: boolean;
  updatedAt: string;
};

export type UpdateSettingsInput = {
  webTerminalEnabled?: boolean;
  terminalCommandGuardEnabled?: boolean;
};

export type SettingsDefaults = {
  webTerminalEnabled?: boolean;
  terminalCommandGuardEnabled?: boolean;
};

export type SettingsRepository = {
  get(): Promise<SettingsRecord | undefined>;
  upsert(
    input: UpdateSettingsInput,
    defaults?: SettingsDefaults,
  ): Promise<SettingsRecord>;
};

type SettingsFile = { settings?: SettingsRecord };

function emptySettingsFile(): SettingsFile {
  return {};
}

export function createJsonSettingsRepository(
  filePath = "data/settings.json",
): SettingsRepository {
  return {
    async get() {
      const data = await readJsonFile<SettingsFile>(
        filePath,
        emptySettingsFile(),
      );
      return data.settings;
    },

    async upsert(input: UpdateSettingsInput, defaults?: SettingsDefaults) {
      return withFileLock(filePath, async () => {
        const data = await readJsonFile<SettingsFile>(
          filePath,
          emptySettingsFile(),
        );
        const existing = data.settings;
        const now = new Date().toISOString();
        const settings: SettingsRecord = {
          id: "dashboard_settings",
          webTerminalEnabled:
            input.webTerminalEnabled !== undefined
              ? input.webTerminalEnabled
              : existing?.webTerminalEnabled !== undefined
                ? existing.webTerminalEnabled
                : defaults?.webTerminalEnabled ?? false,
          terminalCommandGuardEnabled:
            input.terminalCommandGuardEnabled !== undefined
              ? input.terminalCommandGuardEnabled
              : existing?.terminalCommandGuardEnabled !== undefined
                ? existing.terminalCommandGuardEnabled
                : defaults?.terminalCommandGuardEnabled ?? false,
          updatedAt: now,
        };
        data.settings = settings;
        await writeJsonFile(filePath, data);
        return settings;
      });
    },
  };
}

export class InMemorySettingsRepository implements SettingsRepository {
  private settings?: SettingsRecord;

  async get(): Promise<SettingsRecord | undefined> {
    return this.settings;
  }

  async upsert(
    input: UpdateSettingsInput,
    defaults?: SettingsDefaults,
  ): Promise<SettingsRecord> {
    const existing = this.settings;
    this.settings = {
      id: "dashboard_settings",
      webTerminalEnabled:
        input.webTerminalEnabled !== undefined
          ? input.webTerminalEnabled
          : existing?.webTerminalEnabled !== undefined
            ? existing.webTerminalEnabled
            : defaults?.webTerminalEnabled ?? false,
      terminalCommandGuardEnabled:
        input.terminalCommandGuardEnabled !== undefined
          ? input.terminalCommandGuardEnabled
          : existing?.terminalCommandGuardEnabled !== undefined
            ? existing.terminalCommandGuardEnabled
            : defaults?.terminalCommandGuardEnabled ?? false,
      updatedAt: new Date().toISOString(),
    };
    return this.settings;
  }
}
