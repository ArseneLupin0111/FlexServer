-- Terminal accidental command guard setting.
-- Persists whether client-side confirmation is requested before executing high-impact commands.
-- Defaults to false for existing and new deployments.
ALTER TABLE dashboard_settings
  ADD COLUMN IF NOT EXISTS terminal_command_guard_enabled boolean NOT NULL DEFAULT false;

ALTER TABLE dashboard_settings
  ALTER COLUMN web_terminal_enabled SET DEFAULT false;
