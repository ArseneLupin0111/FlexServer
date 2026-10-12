-- Track local updater protocol version (1 = legacy signed catalog, 2 = bundled binary)
ALTER TABLE updater_heartbeats
  ADD COLUMN IF NOT EXISTS protocol_version integer NOT NULL DEFAULT 1;
