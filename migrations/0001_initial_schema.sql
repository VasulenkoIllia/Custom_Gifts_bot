CREATE TABLE IF NOT EXISTS idempotency_keys (
  key TEXT PRIMARY KEY,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS telegram_message_map (
  chat_id TEXT NOT NULL,
  message_id BIGINT NOT NULL,
  order_id TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_heart_count INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (chat_id, message_id)
);

CREATE TABLE IF NOT EXISTS order_workflow_state (
  order_id TEXT PRIMARY KEY,
  highest_stage_index INTEGER NOT NULL,
  applied_status_id INTEGER NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_heart_count INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS dead_letters (
  id BIGSERIAL PRIMARY KEY,
  queue TEXT NOT NULL,
  key TEXT NOT NULL,
  job_id TEXT NOT NULL,
  attempt INTEGER NOT NULL,
  max_attempts INTEGER NOT NULL,
  payload JSONB NOT NULL,
  error_type TEXT NOT NULL,
  retryable BOOLEAN NOT NULL DEFAULT FALSE,
  failure_kind TEXT NULL,
  error TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  finished_at TIMESTAMPTZ NOT NULL,
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS queue_jobs (
  id TEXT PRIMARY KEY,
  queue_name TEXT NOT NULL,
  job_key TEXT NOT NULL,
  payload JSONB NOT NULL,
  status TEXT NOT NULL,
  attempt INTEGER NOT NULL,
  max_attempts INTEGER NOT NULL,
  available_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  lease_owner TEXT NULL,
  lease_expires_at TIMESTAMPTZ NULL,
  error_type TEXT NULL,
  retryable BOOLEAN NOT NULL DEFAULT FALSE,
  failure_kind TEXT NULL,
  error TEXT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  started_at TIMESTAMPTZ NULL,
  finished_at TIMESTAMPTZ NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (status IN ('queued', 'running', 'completed', 'dead_letter')),
  CHECK (attempt >= 1),
  CHECK (max_attempts >= 1)
);

CREATE TABLE IF NOT EXISTS forwarding_events (
  stage_code TEXT NOT NULL,
  order_id TEXT NOT NULL,
  source_chat_id TEXT NOT NULL,
  source_message_id BIGINT NOT NULL,
  target_chat_id TEXT NOT NULL,
  target_thread_id TEXT NOT NULL DEFAULT '',
  mode TEXT NOT NULL,
  target_message_id BIGINT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (
    stage_code,
    source_chat_id,
    source_message_id,
    target_chat_id,
    target_thread_id
  )
);

CREATE TABLE IF NOT EXISTS telegram_delivery_records (
  delivery_key TEXT PRIMARY KEY,
  order_id TEXT NOT NULL,
  status TEXT NOT NULL,
  lease_owner TEXT NULL,
  lease_expires_at TIMESTAMPTZ NULL,
  chat_id TEXT NULL,
  message_ids JSONB NOT NULL DEFAULT '[]'::jsonb,
  preview_message_ids JSONB NOT NULL DEFAULT '[]'::jsonb,
  caption TEXT NOT NULL DEFAULT '',
  warnings JSONB NOT NULL DEFAULT '[]'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  finished_at TIMESTAMPTZ NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (status IN ('pending', 'sent'))
);

CREATE TABLE IF NOT EXISTS forwarding_batches (
  batch_key TEXT PRIMARY KEY,
  order_id TEXT NOT NULL,
  stage_code TEXT NOT NULL,
  target_chat_id TEXT NOT NULL,
  target_thread_id TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL,
  lease_owner TEXT NULL,
  lease_expires_at TIMESTAMPTZ NULL,
  source_messages JSONB NOT NULL DEFAULT '[]'::jsonb,
  forwarded_message_ids JSONB NOT NULL DEFAULT '[]'::jsonb,
  forwarded_count INTEGER NOT NULL DEFAULT 0,
  skipped_count INTEGER NOT NULL DEFAULT 0,
  mode_counts JSONB NOT NULL DEFAULT '{"copy":0,"forward":0}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  finished_at TIMESTAMPTZ NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (status IN ('pending', 'sent'))
);

CREATE TABLE IF NOT EXISTS reaction_rule_config (
  singleton_key TEXT PRIMARY KEY DEFAULT 'default',
  materials_status_id INTEGER NOT NULL,
  missing_file_status_id INTEGER NULL,
  missing_telegram_status_id INTEGER NULL,
  rollback_mode TEXT NOT NULL DEFAULT 'ignore',
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (singleton_key = 'default')
);

CREATE TABLE IF NOT EXISTS reaction_stage_rules (
  code TEXT PRIMARY KEY,
  sort_order INTEGER NOT NULL,
  count_threshold INTEGER NOT NULL,
  status_id INTEGER NOT NULL,
  emoji TEXT NOT NULL,
  emoji_aliases JSONB NOT NULL DEFAULT '[]'::jsonb,
  enabled BOOLEAN NOT NULL DEFAULT TRUE,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS telegram_routing_settings (
  singleton_key TEXT PRIMARY KEY DEFAULT 'default',
  forward_mode TEXT NOT NULL DEFAULT 'copy',
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (singleton_key = 'default')
);

CREATE TABLE IF NOT EXISTS telegram_routing_destinations (
  destination TEXT PRIMARY KEY,
  chat_id TEXT NOT NULL,
  thread_id TEXT NOT NULL DEFAULT '',
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_dead_letters_queue_recorded_at
  ON dead_letters(queue, recorded_at DESC);

CREATE INDEX IF NOT EXISTS idx_dead_letters_recorded_at
  ON dead_letters(recorded_at DESC);

CREATE UNIQUE INDEX IF NOT EXISTS uq_queue_jobs_active_key
  ON queue_jobs(queue_name, job_key)
  WHERE status IN ('queued', 'running');

CREATE INDEX IF NOT EXISTS idx_queue_jobs_claim
  ON queue_jobs(queue_name, status, available_at ASC, created_at ASC);

CREATE INDEX IF NOT EXISTS idx_queue_jobs_lease
  ON queue_jobs(queue_name, status, lease_expires_at ASC);

CREATE INDEX IF NOT EXISTS idx_queue_jobs_retention
  ON queue_jobs(status, finished_at DESC)
  WHERE status IN ('completed', 'dead_letter');

CREATE INDEX IF NOT EXISTS idx_telegram_message_map_order_id
  ON telegram_message_map(order_id, updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_idempotency_keys_created_at
  ON idempotency_keys(created_at DESC);

CREATE INDEX IF NOT EXISTS idx_forwarding_events_order_stage_created_at
  ON forwarding_events(order_id, stage_code, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_telegram_delivery_records_order_id
  ON telegram_delivery_records(order_id, updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_telegram_delivery_records_retention
  ON telegram_delivery_records(status, finished_at DESC)
  WHERE status = 'sent';

CREATE INDEX IF NOT EXISTS idx_forwarding_batches_order_stage
  ON forwarding_batches(order_id, stage_code, updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_forwarding_batches_retention
  ON forwarding_batches(status, finished_at DESC)
  WHERE status = 'sent';

CREATE INDEX IF NOT EXISTS idx_reaction_stage_rules_sort_order
  ON reaction_stage_rules(sort_order ASC);
