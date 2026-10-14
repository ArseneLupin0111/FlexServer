import { readJsonFile, writeJsonFile, withFileLock } from "./json-file.js";

export type SettingsRecord = {
  id: string;
  webTerminalEnabled?: boolean;
  updatedAt: string;
};

export type SettingsRepository = {
  get(): Promise<SettingsRecord | undefined>;
  upsert(input: { webTerminalEnabled: boolean }): Promise<SettingsRecord>;
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

    async upsert(input) {
      return withFileLock(filePath, async () => {
        const data = await readJsonFile<SettingsFile>(
          filePath,
          emptySettingsFile(),
        );
        const now = new Date().toISOString();
        const settings: SettingsRecord = {
          id: "dashboard_settings",
          webTerminalEnabled: input.webTerminalEnabled,
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

  async upsert(input: { webTerminalEnabled: boolean }): Promise<SettingsRecord> {
    this.settings = {
      id: "dashboard_settings",
      webTerminalEnabled: input.webTerminalEnabled,
      updatedAt: new Date().toISOString(),
    };
    return this.settings;
  }
}
