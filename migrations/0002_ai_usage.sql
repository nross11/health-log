-- Counts AI requests per user per UTC day for the daily limit.
CREATE TABLE IF NOT EXISTS ai_usage (
  user_id TEXT NOT NULL,
  day TEXT NOT NULL,
  count INTEGER NOT NULL,
  PRIMARY KEY (user_id, day)
);
