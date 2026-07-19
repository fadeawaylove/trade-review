CREATE TABLE IF NOT EXISTS dataset (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  payload TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS overrides (
  trade_id TEXT PRIMARY KEY,
  payload TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  trade_id TEXT,
  action TEXT NOT NULL,
  actor TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_audit_created_at ON audit_log(created_at);

-- GitHub OAuth authorization codes are single-use. Keep a short-lived receipt so
-- a browser retry/reload of the callback can recover the already-issued session.
CREATE TABLE IF NOT EXISTS oauth_receipts (
  nonce TEXT PRIMARY KEY,
  code_hash TEXT NOT NULL,
  token TEXT NOT NULL,
  return_url TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_oauth_receipts_expires_at ON oauth_receipts(expires_at);
