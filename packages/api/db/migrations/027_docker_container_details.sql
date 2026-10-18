ALTER TABLE docker_metric_samples
  ADD COLUMN IF NOT EXISTS details jsonb;

ALTER TABLE docker_metric_samples
  ADD CONSTRAINT docker_metric_samples_details_shape CHECK (
    details IS NULL OR (container_key IS NOT NULL AND jsonb_typeof(details) = 'object')
  );
