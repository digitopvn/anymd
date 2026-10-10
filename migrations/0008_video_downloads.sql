-- Background YouTube video downloads to the anymd CDN (R2), opted into with the `downloadVideo`
-- reading preference. One row per job; the queue consumer moves it queued → downloading → ready |
-- failed and charges credits only when it reaches ready. Additive: older Workers ignore it.
CREATE TABLE video_jobs (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  api_key_id TEXT,
  channel TEXT NOT NULL,
  video_id TEXT NOT NULL,
  source_url TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('queued', 'downloading', 'ready', 'failed')),
  quality TEXT,
  bytes INTEGER,
  r2_key TEXT,
  cdn_url TEXT,
  credits INTEGER NOT NULL DEFAULT 0,
  error TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  completed_at INTEGER
);
CREATE INDEX video_jobs_user_video ON video_jobs (user_id, video_id, created_at);
