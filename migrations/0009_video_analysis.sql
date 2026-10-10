-- Optional AI analysis of a downloaded YouTube video, opted into with the `analyzeVideo` reading
-- preference. It runs after the download reaches ready: analysis_status NULL (not requested) →
-- queued → running → ready | failed, charged only when ready. Additive: older Workers ignore it.
ALTER TABLE video_jobs ADD COLUMN duration_seconds INTEGER;
ALTER TABLE video_jobs ADD COLUMN analysis_status TEXT CHECK (analysis_status IN ('queued', 'running', 'ready', 'failed'));
ALTER TABLE video_jobs ADD COLUMN analysis_markdown TEXT;
ALTER TABLE video_jobs ADD COLUMN analysis_credits INTEGER NOT NULL DEFAULT 0;
ALTER TABLE video_jobs ADD COLUMN analysis_error TEXT;
-- What the model call cost upstream (USD), to keep the credit price honest.
ALTER TABLE video_jobs ADD COLUMN analysis_cost_usd REAL;
