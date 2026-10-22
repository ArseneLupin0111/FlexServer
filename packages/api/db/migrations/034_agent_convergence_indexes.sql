-- Migration 034: Index for executing agent upgrade jobs serialization and convergence lookups
-- Supports fast concurrency checks for global execution serialization
CREATE INDEX IF NOT EXISTS local_agent_upgrade_jobs_executing
  ON local_agent_upgrade_jobs (state)
  WHERE state IN ('claimed', 'downloading', 'verifying', 'staging', 'restarting', 'awaiting_heartbeat', 'rolling_back');

-- Store original request idempotency key for durable retry tracking across failed/deferred attempts
ALTER TABLE local_agent_upgrade_jobs
  ADD COLUMN IF NOT EXISTS retry_request_key text;

CREATE INDEX IF NOT EXISTS local_agent_upgrade_jobs_retry_request_key
  ON local_agent_upgrade_jobs (vps_id, retry_request_key)
  WHERE retry_request_key IS NOT NULL;
