-- Migration: Create shared_songs table
CREATE TABLE IF NOT EXISTS shared_songs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    original_url TEXT NOT NULL,
    songlink_url TEXT,
    youtube_url TEXT,
    title TEXT,
    shared_by TEXT NOT NULL,
    channel TEXT NOT NULL,
    message_ts TEXT NOT NULL,
    shared_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(channel, message_ts, original_url)
);

CREATE INDEX IF NOT EXISTS idx_shared_songs_shared_at ON shared_songs(shared_at);
CREATE INDEX IF NOT EXISTS idx_shared_songs_channel ON shared_songs(channel);
CREATE INDEX IF NOT EXISTS idx_shared_songs_shared_by ON shared_songs(shared_by);
