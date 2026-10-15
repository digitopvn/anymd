-- MCP Events: owner-scoped webhook subscriptions (MCP 2026-07-28 `events/*`). Additive: new tables
-- only, so the previous Worker version keeps running during rollout and simply never writes them.
--
-- event_subscriptions: one row per (principal, callback url, event name, canonical arguments); `id` is
--   derived from that key. `principal` is the credential that subscribed (`api_key:<id>` or
--   `oauth:<grant id>`), re-checked before every delivery. The callback secret is stored encrypted.
-- event_outbox: one row per committed change that a subscriber may want, written in the same D1 batch
--   as the change itself. Only written when the owner has a live subscription for that event name.
-- event_deliveries: one row per (subscription, event), the retry and dead-letter state of a delivery.
CREATE TABLE event_subscriptions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  principal TEXT NOT NULL,
  principal_hash TEXT NOT NULL,
  name TEXT NOT NULL,
  arguments_json TEXT NOT NULL,
  url TEXT NOT NULL,
  secret_enc TEXT NOT NULL,
  prev_secret_enc TEXT,
  prev_secret_until INTEGER,
  scope TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1,
  verified_at INTEGER,
  expires_at INTEGER NOT NULL,
  last_delivery_at INTEGER,
  last_error TEXT,
  failed_since INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX event_subscriptions_user_name ON event_subscriptions(user_id, name, expires_at);
CREATE INDEX event_subscriptions_principal_url ON event_subscriptions(principal, url);
CREATE INDEX event_subscriptions_expires ON event_subscriptions(expires_at);

CREATE TABLE event_outbox (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  resource_id TEXT NOT NULL,
  data_json TEXT NOT NULL,
  actor_hash TEXT,
  correlation_id TEXT,
  created_at INTEGER NOT NULL,
  dispatched_at INTEGER
);
CREATE INDEX event_outbox_pending ON event_outbox(dispatched_at, created_at);

CREATE TABLE event_deliveries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  subscription_id TEXT NOT NULL REFERENCES event_subscriptions(id) ON DELETE CASCADE,
  event_id TEXT NOT NULL REFERENCES event_outbox(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  -- pending | delivered | failed (non-retryable: 410/413) | dead (retries exhausted)
  status TEXT NOT NULL DEFAULT 'pending',
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at INTEGER NOT NULL,
  last_error TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (subscription_id, event_id)
);
CREATE INDEX event_deliveries_due ON event_deliveries(status, next_attempt_at);
CREATE INDEX event_deliveries_user ON event_deliveries(user_id, status);
