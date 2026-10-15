-- Indexes for the admin KPI and operations views: bounded range scans instead of full-table scans.
-- Additive only; safe while the previous Worker version is still serving.

-- Distinct active users per window read (created_at, user_id) from the index alone.
CREATE INDEX IF NOT EXISTS idx_usage_created_user ON usage_events(created_at, user_id);
-- Sign-ins count as activity for DAU/WAU/MAU.
CREATE INDEX IF NOT EXISTS idx_sessions_created ON sessions(created_at);
-- Webhook outcome filters and keyset pages.
CREATE INDEX IF NOT EXISTS idx_webhook_events_received_id ON webhook_events(received_at DESC, id DESC);
-- Job health and failed-job lists.
CREATE INDEX IF NOT EXISTS idx_video_jobs_status_updated ON video_jobs(status, updated_at);
CREATE INDEX IF NOT EXISTS idx_video_jobs_analysis_updated ON video_jobs(analysis_status, updated_at);
