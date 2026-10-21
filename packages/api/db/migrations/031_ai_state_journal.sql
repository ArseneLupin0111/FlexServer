-- Single transactional journal table for AI Assistant state.
CREATE TABLE IF NOT EXISTS ai_state_journal (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  state JSONB NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
