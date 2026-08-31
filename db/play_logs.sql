CREATE TABLE IF NOT EXISTS play_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    guild_id TEXT,
    requested_by TEXT,
    query TEXT,
    resolved_title TEXT,
    status TEXT,
    error_message TEXT,
    created_at DATETIME DEFAULT (datetime('now', 'localtime'))
);