-- Single transactional admission authority for Compose state. An advisory
-- transaction lock serializes state transitions across API instances.
CREATE TABLE docker_application_state (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  payload JSONB NOT NULL
);
