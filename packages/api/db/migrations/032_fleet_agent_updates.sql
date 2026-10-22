-- Fleet agent updates, policies, rollouts, releases, and notifications.

CREATE TABLE IF NOT EXISTS fleet_policies (
  vps_id text PRIMARY KEY REFERENCES vps(id) ON DELETE CASCADE,
  mode text NOT NULL DEFAULT 'auto' CHECK (mode IN ('auto', 'manual', 'pinned')),
  policy_group text NOT NULL DEFAULT 'Default',
  pinned_release_id text,
  canary boolean NOT NULL DEFAULT false,
  maintenance_window jsonb,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS fleet_enrollments (
  vps_id text PRIMARY KEY REFERENCES vps(id) ON DELETE CASCADE,
  enrolled boolean NOT NULL DEFAULT true,
  enrolled_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS fleet_releases (
  release_id text PRIMARY KEY,
  version text NOT NULL,
  build_id text NOT NULL,
  published_at timestamptz NOT NULL,
  rollback_safe boolean NOT NULL DEFAULT true,
  payload text NOT NULL,
  signature text NOT NULL,
  key_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS fleet_rollouts (
  id text PRIMARY KEY,
  release_id text NOT NULL,
  state text NOT NULL CHECK (state IN ('pending', 'running', 'paused', 'completed', 'failed')),
  policy_group text NOT NULL,
  hosts jsonb NOT NULL DEFAULT '[]',
  reason text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS fleet_rollouts_single_active
  ON fleet_rollouts ((true))
  WHERE state IN ('pending', 'running');

CREATE TABLE IF NOT EXISTS fleet_notifications (
  id text PRIMARY KEY,
  message text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('info', 'warning', 'error', 'success')),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS fleet_notifications_created_at
  ON fleet_notifications (created_at DESC);

-- Extend updater_heartbeats with protocol 3 evidence fields
ALTER TABLE updater_heartbeats
  ADD COLUMN IF NOT EXISTS updater_version text,
  ADD COLUMN IF NOT EXISTS platform jsonb,
  ADD COLUMN IF NOT EXISTS idle boolean,
  ADD COLUMN IF NOT EXISTS busy_reason text,
  ADD COLUMN IF NOT EXISTS installed_ai jsonb,
  ADD COLUMN IF NOT EXISTS ai_health jsonb;

-- Extend local_agent_upgrade_jobs with components and manifest hash
ALTER TABLE local_agent_upgrade_jobs
  ADD COLUMN IF NOT EXISTS components jsonb,
  ADD COLUMN IF NOT EXISTS manifest_sha256 text;
