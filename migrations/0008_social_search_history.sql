-- Saved social searches, so the dashboard can list past searches and show their results again.
-- One row per search page (id = its trace id); only the newest rows per user are kept. Additive.
CREATE TABLE social_searches (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  platform TEXT NOT NULL,
  query TEXT NOT NULL,
  channel TEXT NOT NULL,
  paged INTEGER NOT NULL DEFAULT 0,
  result_count INTEGER NOT NULL,
  credits INTEGER NOT NULL,
  results_json TEXT NOT NULL CHECK (json_valid(results_json)),
  platforms_json TEXT NOT NULL CHECK (json_valid(platforms_json)),
  next_cursor TEXT,
  duration_ms INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX social_searches_user_created ON social_searches(user_id, created_at DESC);
