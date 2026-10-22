-- Migration 033: Agent deploy convergence schema
-- Add target_arch column to local_agent_upgrade_jobs (nullable, no default)
ALTER TABLE local_agent_upgrade_jobs
  ADD COLUMN IF NOT EXISTS target_arch text;

-- Extend state check constraint to include deferred and superseded
ALTER TABLE local_agent_upgrade_jobs
  DROP CONSTRAINT IF EXISTS local_agent_upgrade_jobs_state_check;

ALTER TABLE local_agent_upgrade_jobs
  DROP CONSTRAINT IF EXISTS local_agent_upgrade_jobs_check;

ALTER TABLE local_agent_upgrade_jobs
  ADD CONSTRAINT local_agent_upgrade_jobs_state_check CHECK (state IN (
    'queued', 'claimed', 'downloading', 'verifying', 'staging',
    'restarting', 'awaiting_heartbeat', 'rolling_back',
    'succeeded', 'rolled_back', 'rollback_unverified', 'failed',
    'deferred', 'superseded'
  ));

-- Update active job unique index to exclude deferred and superseded
DROP INDEX IF EXISTS local_agent_upgrade_jobs_active;

CREATE UNIQUE INDEX IF NOT EXISTS local_agent_upgrade_jobs_active
  ON local_agent_upgrade_jobs (vps_id)
  WHERE state NOT IN ('succeeded', 'rolled_back', 'rollback_unverified', 'failed', 'deferred', 'superseded');

-- Convergence persistence table
CREATE TABLE IF NOT EXISTS agent_deploy_convergence (
  vps_id text PRIMARY KEY REFERENCES vps(id) ON DELETE CASCADE,
  suppressed_build_id text,
  suppressed_reason text,
  retry_build_id text,
  retry_key text,
  setup_state text NOT NULL DEFAULT 'unknown' CHECK (setup_state IN ('unknown', 'ready', 'needs_access', 'failed')),
  setup_reason text,
  next_setup_attempt_at timestamptz
);
