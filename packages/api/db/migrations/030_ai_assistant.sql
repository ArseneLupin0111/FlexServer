-- AI Assistant persistent storage schema
CREATE TABLE IF NOT EXISTS ai_settings (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  endpoint TEXT NOT NULL DEFAULT 'https://api.openai.com',
  model TEXT NOT NULL DEFAULT 'gpt-4o',
  encrypted_api_key JSONB,
  allow_private_endpoint BOOLEAN NOT NULL DEFAULT false,
  revision INTEGER NOT NULL DEFAULT 1,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Seed default global settings row if missing
INSERT INTO ai_settings (id, endpoint, model, encrypted_api_key, allow_private_endpoint, revision, updated_at)
VALUES (1, 'https://api.openai.com', 'gpt-4o', NULL, false, 1, NOW())
ON CONFLICT (id) DO NOTHING;

CREATE TABLE IF NOT EXISTS ai_policies (
  vps_id TEXT PRIMARY KEY REFERENCES vps(id) ON DELETE CASCADE,
  ai_enabled BOOLEAN NOT NULL DEFAULT false,
  read_enabled BOOLEAN NOT NULL DEFAULT false,
  docker_actions_enabled BOOLEAN NOT NULL DEFAULT false,
  compose_actions_enabled BOOLEAN NOT NULL DEFAULT false,
  shell_enabled BOOLEAN NOT NULL DEFAULT false,
  file_read_scopes JSONB NOT NULL DEFAULT '[]'::jsonb,
  file_write_scopes JSONB NOT NULL DEFAULT '[]'::jsonb,
  service_profile_ids JSONB NOT NULL DEFAULT '[]'::jsonb,
  send_logs_to_provider BOOLEAN NOT NULL DEFAULT false,
  send_files_to_provider BOOLEAN NOT NULL DEFAULT false,
  revision INTEGER NOT NULL DEFAULT 1,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS ai_capabilities (
  vps_id TEXT PRIMARY KEY REFERENCES vps(id) ON DELETE CASCADE,
  supported BOOLEAN NOT NULL DEFAULT false,
  reason TEXT,
  freshness TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  agent_version TEXT,
  protocol_version INTEGER NOT NULL DEFAULT 1,
  cgroup_v2_available BOOLEAN NOT NULL DEFAULT false,
  namespaces_available BOOLEAN NOT NULL DEFAULT false,
  seccomp_available BOOLEAN NOT NULL DEFAULT false,
  profiles JSONB NOT NULL DEFAULT '[]'::jsonb,
  rootfs_digest TEXT
);

CREATE TABLE IF NOT EXISTS ai_conversations (
  id TEXT PRIMARY KEY,
  vps_id TEXT NOT NULL REFERENCES vps(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS ai_conversations_vps_idx ON ai_conversations(vps_id, updated_at DESC);

CREATE TABLE IF NOT EXISTS ai_conversation_messages (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES ai_conversations(id) ON DELETE CASCADE,
  task_id TEXT,
  role TEXT NOT NULL,
  content TEXT NOT NULL,
  evidence JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS ai_conversation_messages_idx ON ai_conversation_messages(conversation_id, created_at ASC);

CREATE TABLE IF NOT EXISTS ai_tasks (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES ai_conversations(id) ON DELETE CASCADE,
  vps_id TEXT NOT NULL REFERENCES vps(id) ON DELETE CASCADE,
  state TEXT NOT NULL,
  revision INTEGER NOT NULL DEFAULT 1,
  request_summary TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  summary TEXT,
  clarification_prompt TEXT,
  plan JSONB,
  usage JSONB NOT NULL DEFAULT '{"inputTokens":0,"outputTokens":0,"estimated":false,"rounds":0,"toolCalls":0}'::jsonb,
  error JSONB,
  initiating_session_id TEXT NOT NULL,
  capability_metadata JSONB,
  owner_lease_expires_at TIMESTAMPTZ,
  owner_instance_id TEXT,
  expires_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS ai_tasks_vps_idempotency_idx ON ai_tasks (vps_id, idempotency_key);
CREATE UNIQUE INDEX IF NOT EXISTS ai_tasks_active_vps_idx ON ai_tasks (vps_id)
  WHERE state IN ('planning', 'awaiting_input', 'awaiting_approval', 'executing', 'verifying', 'cancel_requested', 'uncertain');

CREATE TABLE IF NOT EXISTS ai_outbox (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES ai_tasks(id) ON DELETE CASCADE,
  step_id TEXT NOT NULL,
  command_id TEXT NOT NULL UNIQUE,
  vps_id TEXT NOT NULL REFERENCES vps(id) ON DELETE CASCADE,
  agent_instance_id TEXT NOT NULL,
  command JSONB NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  dispatched_at TIMESTAMPTZ,
  acknowledged_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS ai_outbox_queue_idx ON ai_outbox(vps_id, status, created_at ASC);

CREATE TABLE IF NOT EXISTS ai_receipts (
  command_id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES ai_tasks(id) ON DELETE CASCADE,
  step_id TEXT NOT NULL,
  vps_id TEXT NOT NULL REFERENCES vps(id) ON DELETE CASCADE,
  agent_instance_id TEXT NOT NULL,
  plan_version INTEGER NOT NULL,
  plan_digest TEXT NOT NULL,
  payload_digest TEXT NOT NULL,
  status TEXT NOT NULL,
  result JSONB,
  error JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS ai_receipts_task_idx ON ai_receipts(task_id, created_at ASC);

CREATE TABLE IF NOT EXISTS ai_execution_blobs (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES ai_tasks(id) ON DELETE CASCADE,
  step_id TEXT NOT NULL,
  encrypted_payload JSONB NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS ai_execution_blobs_task_idx ON ai_execution_blobs(task_id);

CREATE TABLE IF NOT EXISTS ai_audit_events (
  id TEXT PRIMARY KEY,
  actor_session_id TEXT NOT NULL,
  vps_id TEXT NOT NULL REFERENCES vps(id) ON DELETE CASCADE,
  task_id TEXT,
  tool_name TEXT,
  digest TEXT,
  operation_id TEXT,
  result_code TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS ai_audit_events_vps_idx ON ai_audit_events(vps_id, created_at DESC);
