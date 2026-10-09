-- Admin control plane. Additive only: every new column has a default or is nullable, so the
-- previous Worker version keeps working during rollout and after a rollback.

-- First-class audit log: who acted, through which credential and adapter, for which request.
ALTER TABLE audit_log ADD COLUMN actor_user_id TEXT;
ALTER TABLE audit_log ADD COLUMN auth_kind TEXT;
ALTER TABLE audit_log ADD COLUMN credential_id TEXT;   -- API key id or OAuth client id
ALTER TABLE audit_log ADD COLUMN target_type TEXT NOT NULL DEFAULT '';
ALTER TABLE audit_log ADD COLUMN via TEXT;             -- mcp:<tool> | api:<METHOD route> | web:<route> | webhook:<provider>
ALTER TABLE audit_log ADD COLUMN request_id TEXT;
ALTER TABLE audit_log ADD COLUMN idempotency_key TEXT;
CREATE INDEX IF NOT EXISTS idx_audit_actor_created ON audit_log(actor_user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_action_created ON audit_log(action, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_target_created ON audit_log(target, created_at DESC);

-- Account status for support actions. Suspended accounts cannot sign in or use keys and grants.
ALTER TABLE users ADD COLUMN status TEXT NOT NULL DEFAULT 'active';   -- active | suspended
ALTER TABLE users ADD COLUMN status_reason TEXT NOT NULL DEFAULT '';
CREATE INDEX IF NOT EXISTS idx_users_created ON users(created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_users_role_created ON users(role, created_at DESC);

-- Credit-grant lifecycle: reason, actor, idempotency and revocation.
ALTER TABLE credit_grants ADD COLUMN reason TEXT NOT NULL DEFAULT '';
ALTER TABLE credit_grants ADD COLUMN created_by TEXT;
ALTER TABLE credit_grants ADD COLUMN idempotency_key TEXT;
ALTER TABLE credit_grants ADD COLUMN revoked_at INTEGER;
ALTER TABLE credit_grants ADD COLUMN revoked_by TEXT;
ALTER TABLE credit_grants ADD COLUMN revoke_reason TEXT NOT NULL DEFAULT '';
CREATE UNIQUE INDEX IF NOT EXISTS idx_credit_grants_idempotency ON credit_grants(user_id, idempotency_key) WHERE idempotency_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_credit_grants_created ON credit_grants(created_at DESC);

-- One version counter for the settings table, so concurrent admin writes cannot silently overwrite each other.
CREATE TABLE IF NOT EXISTS settings_state (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  version INTEGER NOT NULL,
  write_token TEXT,
  updated_at INTEGER NOT NULL DEFAULT 0,
  updated_by TEXT
);
INSERT OR IGNORE INTO settings_state (id, version, updated_at) VALUES (1, 1, 0);

-- Billing webhook diagnostics.
ALTER TABLE webhook_events ADD COLUMN provider TEXT;
ALTER TABLE webhook_events ADD COLUMN outcome TEXT;
CREATE INDEX IF NOT EXISTS idx_webhook_events_received ON webhook_events(received_at DESC);

-- Bounded system-wide views.
CREATE INDEX IF NOT EXISTS idx_traces_created ON traces(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_subscriptions_status ON subscriptions(status, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_subscriptions_created ON subscriptions(created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_subscriptions_status_created ON subscriptions(status, created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_idempotency_created ON idempotency_keys(created_at);
