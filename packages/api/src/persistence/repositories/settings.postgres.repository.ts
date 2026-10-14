import type { DatabasePool } from "../../db/pool.js";
import type {
  SettingsDefaults,
  SettingsRecord,
  SettingsRepository,
  UpdateSettingsInput,
} from "./settings.repository.js";
import { requiredIsoString } from "./postgres-mappers.js";

type SettingsRow = {
  id: string;
  web_terminal_enabled: boolean;
  terminal_command_guard_enabled: boolean;
  updated_at: Date | string;
};

export function createPostgresSettingsRepository(
  pool: DatabasePool,
): SettingsRepository {
  return {
    async get() {
      const result = await pool.query<SettingsRow>(
        "SELECT * FROM dashboard_settings WHERE id = 'dashboard_settings'",
      );
      return result.rows[0] ? rowToSettings(result.rows[0]) : undefined;
    },

    async upsert(input: UpdateSettingsInput, defaults?: SettingsDefaults) {
      const now = new Date().toISOString();
      const result = await pool.query<SettingsRow>(
        `INSERT INTO dashboard_settings (
           id,
           web_terminal_enabled,
           terminal_command_guard_enabled,
           updated_at
         )
         VALUES (
           'dashboard_settings',
           COALESCE($1, $2, false),
           COALESCE($3, $4, false),
           $5
         )
         ON CONFLICT (id) DO UPDATE SET
           web_terminal_enabled = COALESCE($1, dashboard_settings.web_terminal_enabled),
           terminal_command_guard_enabled = COALESCE($3, dashboard_settings.terminal_command_guard_enabled),
           updated_at = EXCLUDED.updated_at
         RETURNING *`,
        [
          input.webTerminalEnabled !== undefined ? input.webTerminalEnabled : null,
          defaults?.webTerminalEnabled !== undefined ? defaults.webTerminalEnabled : null,
          input.terminalCommandGuardEnabled !== undefined ? input.terminalCommandGuardEnabled : null,
          defaults?.terminalCommandGuardEnabled !== undefined ? defaults.terminalCommandGuardEnabled : null,
          now,
        ],
      );
      return rowToSettings(result.rows[0]!);
    },
  };
}

function rowToSettings(row: SettingsRow): SettingsRecord {
  return {
    id: row.id,
    webTerminalEnabled: row.web_terminal_enabled ?? false,
    terminalCommandGuardEnabled: row.terminal_command_guard_enabled ?? false,
    updatedAt: requiredIsoString(row.updated_at),
  };
}
