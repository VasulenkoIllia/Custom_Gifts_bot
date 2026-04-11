CREATE INDEX IF NOT EXISTS idx_queue_jobs_retention_updated
  ON queue_jobs(status, updated_at DESC)
  WHERE status IN ('completed', 'dead_letter')
    AND finished_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_telegram_delivery_records_retention_updated
  ON telegram_delivery_records(status, updated_at DESC)
  WHERE status = 'sent'
    AND finished_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_forwarding_batches_retention_updated
  ON forwarding_batches(status, updated_at DESC)
  WHERE status = 'sent'
    AND finished_at IS NULL;
