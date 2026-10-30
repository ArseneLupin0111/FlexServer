-- Migration 037: AI Agent multi-turn loop domain state and execution mode policy
ALTER TABLE ai_policies
  ADD COLUMN IF NOT EXISTS execution_mode TEXT NOT NULL DEFAULT 'manual',
  ADD COLUMN IF NOT EXISTS yolo_acknowledged_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS yolo_acknowledged_by TEXT,
  DROP COLUMN IF EXISTS auto_approve;

ALTER TABLE ai_tasks
  ADD COLUMN IF NOT EXISTS execution_version INTEGER NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS execution_mode TEXT,
  ADD COLUMN IF NOT EXISTS loop JSONB,
  ADD COLUMN IF NOT EXISTS completion JSONB;

-- Migrate ai_state_journal JSONB document (id = 1) if it exists:
-- 1. Ensure all legacy tasks have executionVersion = 1 if missing, preserving existing plan, state, etc.
-- 2. Normalize policies to have executionMode, strip autoApprove, and set yolo acknowledgment fields.
DO $$
DECLARE
  v_state JSONB;
  v_tasks JSONB;
  v_policies JSONB;
BEGIN
  SELECT state INTO v_state FROM ai_state_journal WHERE id = 1 FOR UPDATE;
  IF FOUND AND v_state IS NOT NULL THEN
    -- Normalize tasks array
    IF v_state ? 'tasks' AND jsonb_typeof(v_state->'tasks') = 'array' THEN
      SELECT COALESCE(jsonb_agg(
        CASE
          WHEN elem ? 'executionVersion' THEN elem
          ELSE elem || '{"executionVersion": 1}'::jsonb
        END
      ), '[]'::jsonb) INTO v_tasks
      FROM jsonb_array_elements(v_state->'tasks') AS elem;
    ELSE
      v_tasks := COALESCE(v_state->'tasks', '[]'::jsonb);
    END IF;

    -- Normalize policies array: strip autoApprove, ensure executionMode and acknowledgment fields
    IF v_state ? 'policies' AND jsonb_typeof(v_state->'policies') = 'array' THEN
      SELECT COALESCE(jsonb_agg(
        (elem - 'autoApprove') || jsonb_build_object(
          'executionMode', COALESCE(elem->>'executionMode', 'manual'),
          'yoloAcknowledgedAt', elem->'yoloAcknowledgedAt',
          'yoloAcknowledgedBy', elem->'yoloAcknowledgedBy'
        )
      ), '[]'::jsonb) INTO v_policies
      FROM jsonb_array_elements(v_state->'policies') AS elem;
    ELSE
      v_policies := COALESCE(v_state->'policies', '[]'::jsonb);
    END IF;

    UPDATE ai_state_journal
    SET state = v_state || jsonb_build_object(
      'tasks', v_tasks,
      'policies', v_policies
    ),
    updated_at = NOW()
    WHERE id = 1;
  END IF;
END $$;
