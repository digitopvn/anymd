-- Social search paging sessions and filter details on saved searches. Additive; rows from earlier Workers stay readable.
-- A session holds what the next page of one search needs: each provider's cursor, the resolved UTC time range and the
-- exact identities of posts already returned, so later pages never repeat a post. `version` makes each cursor
-- single-use: it only moves when a page is delivered. A request holds a short lease (`lease_owner`, `lease_until`)
-- while it fetches, so a concurrent request with the same cursor is refused, and a request that dies mid-page
-- (client gone, isolate evicted) frees the cursor when its lease runs out. Sessions expire after 24 hours and are
-- swept by the scheduled handler.
CREATE TABLE social_search_sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  platform TEXT NOT NULL,
  query_key TEXT NOT NULL,
  period TEXT,
  since_ms INTEGER,
  until_ms INTEGER,
  cursors_json TEXT NOT NULL CHECK (json_valid(cursors_json)),
  seen_json TEXT NOT NULL CHECK (json_valid(seen_json)),
  pages INTEGER NOT NULL DEFAULT 1,
  version INTEGER NOT NULL DEFAULT 1,
  lease_owner TEXT,
  lease_until INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX social_search_sessions_user ON social_search_sessions(user_id, updated_at);
CREATE INDEX social_search_sessions_expiry ON social_search_sessions(expires_at);

-- Time range, filter counts and coverage of a saved search page (JSON); NULL for searches saved before filters existed.
ALTER TABLE social_searches ADD COLUMN filters_json TEXT CHECK (filters_json IS NULL OR json_valid(filters_json));
