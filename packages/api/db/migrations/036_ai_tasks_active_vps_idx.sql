-- Migration 036: Exclude 'uncertain' from active tasks unique index so chat/planning can continue
DROP INDEX IF EXISTS ai_tasks_active_vps_idx;
CREATE UNIQUE INDEX IF NOT EXISTS ai_tasks_active_vps_idx ON ai_tasks (vps_id)
  WHERE state IN ('planning', 'awaiting_input', 'awaiting_approval', 'executing', 'verifying', 'cancel_requested');
