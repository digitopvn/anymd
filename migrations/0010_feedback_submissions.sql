-- Product feedback published as public GitHub issues. Additive: a new table only, so the previous
-- Worker version keeps running during rollout. The account link lives here and never reaches GitHub.
-- status: received | publishing | created | pending_retry | unknown_remote_state | needs_review | failed.
-- publishing_lease_until doubles as the not-before time of a pending_retry row.
CREATE TABLE feedback_submissions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type TEXT NOT NULL,
  title TEXT NOT NULL,
  sanitized_body TEXT NOT NULL,
  channel TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  payload_hash TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  status TEXT NOT NULL,
  github_issue_number INTEGER,
  github_issue_url TEXT,
  attempt_count INTEGER NOT NULL DEFAULT 0,
  last_error_code TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  publishing_lease_until INTEGER,
  publicly_confirmed_at INTEGER NOT NULL,
  UNIQUE (user_id, idempotency_key)
);
CREATE INDEX feedback_user_created ON feedback_submissions(user_id, created_at DESC);
CREATE INDEX feedback_content_hash ON feedback_submissions(content_hash, created_at DESC);
CREATE INDEX feedback_status_updated ON feedback_submissions(status, updated_at);
