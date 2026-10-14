CREATE TABLE IF NOT EXISTS dashboard_settings (
  id text PRIMARY KEY DEFAULT 'dashboard_settings',
  web_terminal_enabled boolean NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);
