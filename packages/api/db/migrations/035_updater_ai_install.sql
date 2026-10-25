-- Local/system host AI first-install via the pull updater (job kind ai-install).
-- Job kind distinguishes AI installs from agent binary updates; legacy rows
-- (NULL) mean the agent update path. Heartbeat capabilities carry the helper's
-- live feature evidence (cleared when a claim stops reporting it).
ALTER TABLE local_agent_upgrade_jobs
  ADD COLUMN IF NOT EXISTS kind text NOT NULL DEFAULT 'agent-update';

ALTER TABLE updater_heartbeats
  ADD COLUMN IF NOT EXISTS capabilities jsonb,
  ADD COLUMN IF NOT EXISTS capabilities_at timestamptz;
