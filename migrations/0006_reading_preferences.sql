-- User-scoped reading (deep reading) defaults. One validated JSON object per user; a missing row
-- means the safe defaults (every credit-consuming enrichment off). Additive: older Workers ignore it.
CREATE TABLE reading_preferences (
  user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  preferences TEXT NOT NULL CHECK (json_valid(preferences)),
  updated_at INTEGER NOT NULL
);
