-- Reservations enforce conversion budgets independently from asynchronous telemetry.
CREATE TABLE conversion_charges (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  reserved INTEGER NOT NULL CHECK (reserved >= 0),
  credits INTEGER NOT NULL DEFAULT 0 CHECK (credits >= 0 AND credits <= reserved),
  settled INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX conversion_charges_user_month ON conversion_charges(user_id, created_at);
ALTER TABLE documents ADD COLUMN enrichment_json TEXT;
ALTER TABLE documents ADD COLUMN base_markdown TEXT;
