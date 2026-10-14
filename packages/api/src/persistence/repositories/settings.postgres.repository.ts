import type { DatabasePool } from "../../db/pool.js";
import type {
  SettingsRecord,
  SettingsRepository,
} from "./settings.repository.js";
import { requiredIsoString } from "./postgres-mappers.js";

type SettingsRow = {
  id: string;
  web_terminal_enabled: boolean;
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

    async upsert(input) {
      const now = new Date().toISOString();
      const result = await pool.query<SettingsRow>(
        `INSERT INTO dashboard_settings (id, web_terminal_enabled, updated_at)
         VALUES ('dashboard_settings', $1, $2)
         ON CONFLICT (id) DO UPDATE SET
           web_terminal_enabled = EXCLUDED.web_terminal_enabled,
           updated_at = EXCLUDED.updated_at
         RETURNING *`,
        [input.webTerminalEnabled, now],
      );
      return rowToSettings(result.rows[0]!);
    },
  };
}

function rowToSettings(row: SettingsRow): SettingsRecord {
  return {
    id: row.id,
    webTerminalEnabled: row.web_terminal_enabled,
    updatedAt: requiredIsoString(row.updated_at),
  };
}
