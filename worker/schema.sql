CREATE TABLE IF NOT EXISTS posts (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  message TEXT NOT NULL,
  photo BLOB NOT NULL,
  clip BLOB,
  clip_type TEXT,
  ip_hash TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  created_at INTEGER NOT NULL,
  taken_on TEXT -- YYYY-MM-DD, added by migrations/0003_taken_on.sql
);
CREATE INDEX IF NOT EXISTS posts_status_created ON posts (status, created_at);
CREATE INDEX IF NOT EXISTS posts_ip_created ON posts (ip_hash, created_at);
