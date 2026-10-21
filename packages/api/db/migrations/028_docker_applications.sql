-- Docker applications (Compose phase 2): discovery, sources, revisions,
-- secrets, registry credentials, previews, durable operations with mutation
-- authorization, inventory snapshots, and the shared cross-domain contention
-- registry with legacy container management.
-- Separate VPS gate (default false) lives on vps (028 adds the column).

ALTER TABLE vps
  ADD COLUMN compose_management_enabled BOOLEAN NOT NULL DEFAULT FALSE;

CREATE TABLE docker_applications (
  id TEXT PRIMARY KEY,
  vps_id TEXT NOT NULL REFERENCES vps (id) ON DELETE CASCADE,
  display_name TEXT NOT NULL,
  project_name TEXT NOT NULL,
  daemon_epoch TEXT NOT NULL,
  agent_instance_id TEXT,
  mode TEXT NOT NULL
    CHECK (mode IN ('detected_readonly', 'external_control', 'managed', 'unmanaged')),
  generation INTEGER NOT NULL DEFAULT 0,
  source JSONB,
  owner_manifest JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (vps_id, daemon_epoch, project_name)
);

CREATE TABLE docker_application_revisions (
  id TEXT PRIMARY KEY,
  vps_id TEXT NOT NULL REFERENCES vps (id) ON DELETE CASCADE,
  app_id TEXT NOT NULL REFERENCES docker_applications (id) ON DELETE CASCADE,
  seq INTEGER NOT NULL,
  compose_yaml_secret JSONB NOT NULL,
  non_secret_variables JSONB NOT NULL DEFAULT '[]',
  profiles JSONB NOT NULL DEFAULT '[]',
  one_shot_services JSONB NOT NULL DEFAULT '[]',
  source_hash TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (app_id, seq)
);

CREATE TABLE docker_application_secrets (
  id TEXT PRIMARY KEY,
  vps_id TEXT NOT NULL REFERENCES vps (id) ON DELETE CASCADE,
  app_id TEXT NOT NULL REFERENCES docker_applications (id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  envelope JSONB NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (app_id, name)
);

CREATE TABLE docker_registry_credentials (
  id TEXT PRIMARY KEY,
  vps_id TEXT NOT NULL REFERENCES vps (id) ON DELETE CASCADE,
  host TEXT NOT NULL,
  username TEXT,
  envelope JSONB NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (vps_id, host)
);

CREATE TABLE docker_application_previews (
  id TEXT PRIMARY KEY,
  vps_id TEXT NOT NULL REFERENCES vps (id) ON DELETE CASCADE,
  app_id TEXT NOT NULL REFERENCES docker_applications (id) ON DELETE CASCADE,
  revision_seq INTEGER NOT NULL,
  digest TEXT NOT NULL,
  resolved_model_secret JSONB,
  redacted_model JSONB,
  image_digests JSONB,
  observed_fingerprint JSONB,
  secret_version INTEGER NOT NULL,
  credential_version INTEGER NOT NULL,
  source_binding_digest TEXT,
  request JSONB,
  status TEXT NOT NULL
    CHECK (status IN ('pending', 'ready', 'failed', 'stale', 'expired')),
  error JSONB,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE docker_application_operations (
  id TEXT PRIMARY KEY,
  vps_id TEXT NOT NULL REFERENCES vps (id) ON DELETE CASCADE,
  app_id TEXT REFERENCES docker_applications (id) ON DELETE CASCADE,
  kind TEXT NOT NULL
    CHECK (kind IN ('deploy', 'lifecycle_start', 'lifecycle_stop', 'lifecycle_restart',
                    'resume', 'removed_service', 'unmanage', 'recheck', 'runtime_prep')),
  status TEXT NOT NULL
    CHECK (status IN ('prepared', 'claimed', 'preflighting', 'pulling', 'applying',
                      'observing', 'succeeded', 'failed', 'cancelled', 'uncertain')),
  preview_id TEXT REFERENCES docker_application_previews (id) ON DELETE SET NULL,
  revision_seq INTEGER,
  approved_digest TEXT,
  generation INTEGER NOT NULL,
  secret_version INTEGER NOT NULL,
  credential_version INTEGER NOT NULL,
  idempotency_key TEXT NOT NULL,
  request JSONB NOT NULL DEFAULT '{}',
  "authorization" JSONB,
  mutation_started_at TIMESTAMPTZ,
  claimed_by TEXT,
  claim_token_hash TEXT,
  claim_lease_expires_at TIMESTAMPTZ,
  progress JSONB,
  events JSONB NOT NULL DEFAULT '[]',
  result JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (vps_id, app_id, kind, idempotency_key)
);

CREATE UNIQUE INDEX docker_application_operations_one_active
  ON docker_application_operations (app_id)
  WHERE status IN ('prepared', 'claimed', 'preflighting', 'pulling', 'applying',
                   'observing', 'uncertain');

CREATE TABLE docker_application_inventories (
  id TEXT PRIMARY KEY,
  vps_id TEXT NOT NULL REFERENCES vps (id) ON DELETE CASCADE,
  agent_instance_id TEXT NOT NULL,
  daemon_epoch TEXT NOT NULL,
  sequence INTEGER NOT NULL,
  collected_at TIMESTAMPTZ NOT NULL,
  received_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completeness BOOLEAN NOT NULL,
  completeness_reason TEXT,
  capabilities JSONB NOT NULL DEFAULT '{}',
  projects JSONB NOT NULL DEFAULT '[]',
  payload JSONB NOT NULL,
  UNIQUE (vps_id, agent_instance_id, daemon_epoch, sequence)
);

CREATE TABLE docker_operation_contentions (
  id BIGSERIAL PRIMARY KEY,
  vps_id TEXT NOT NULL REFERENCES vps (id) ON DELETE CASCADE,
  scope_key TEXT NOT NULL,
  holder_kind TEXT NOT NULL,
  holder_id TEXT NOT NULL,
  granted_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at TIMESTAMPTZ
);
CREATE INDEX docker_operation_contentions_scope_idx
  ON docker_operation_contentions (vps_id, scope_key);
