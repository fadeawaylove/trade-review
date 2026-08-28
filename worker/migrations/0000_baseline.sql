-- Idempotent v1 baseline. Existing databases already have these objects, while
-- a new empty database needs the legacy shape before 0001_journal_v2.sql ALTERs it.
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

CREATE TABLE IF NOT EXISTS silver_target_settings (
  login TEXT PRIMARY KEY,
  contract TEXT NOT NULL DEFAULT '',
  xag_anchor REAL CHECK (xag_anchor IS NULL OR xag_anchor > 0),
  ag_anchor REAL CHECK (ag_anchor IS NULL OR ag_anchor > 0),
  xag_target REAL CHECK (xag_target IS NULL OR xag_target > 0),
  tolerance_percent REAL NOT NULL DEFAULT 0.5 CHECK (tolerance_percent >= 0 AND tolerance_percent <= 10),
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS silver_market_anchors (
  contract TEXT PRIMARY KEY CHECK (contract GLOB 'AG[0-9][0-9][0-9][0-9]'),
  xag_anchor REAL NOT NULL CHECK (xag_anchor > 0),
  ag_anchor REAL NOT NULL CHECK (ag_anchor > 0),
  xag_quote_at TEXT NOT NULL,
  ag_quote_at TEXT NOT NULL,
  fetched_at TEXT NOT NULL,
  source TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS silver_target_contract_preferences (
  login TEXT PRIMARY KEY,
  mode TEXT NOT NULL CHECK (mode IN ('auto', 'manual')),
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS silver_ag_main_contract_state (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  current_contract TEXT CHECK (current_contract IS NULL OR current_contract GLOB 'AG[0-9][0-9][0-9][0-9]'),
  candidate_contract TEXT CHECK (candidate_contract IS NULL OR candidate_contract GLOB 'AG[0-9][0-9][0-9][0-9]'),
  candidate_hour_count INTEGER NOT NULL DEFAULT 0 CHECK (candidate_hour_count >= 0),
  candidate_last_hour_bucket TEXT,
  selected_at TEXT,
  observed_at TEXT,
  error TEXT
);

CREATE TABLE IF NOT EXISTS audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  trade_id TEXT,
  action TEXT NOT NULL,
  actor TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_audit_created_at ON audit_log(created_at);

CREATE TABLE IF NOT EXISTS oauth_receipts (
  nonce TEXT PRIMARY KEY,
  code_hash TEXT NOT NULL,
  token TEXT NOT NULL,
  return_url TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_oauth_receipts_expires_at ON oauth_receipts(expires_at);

CREATE TABLE IF NOT EXISTS revoked_sessions (
  jti TEXT PRIMARY KEY,
  login TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  revoked_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_revoked_sessions_expires_at ON revoked_sessions(expires_at);

CREATE TABLE IF NOT EXISTS access_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  actor TEXT NOT NULL,
  resource_type TEXT NOT NULL CHECK (resource_type IN ('dashboard', 'trade', 'article')),
  resource_id TEXT NOT NULL,
  action TEXT NOT NULL CHECK (action IN ('view')),
  title TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_access_history_created_at ON access_history(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_access_history_actor_created_at ON access_history(actor, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_access_history_resource ON access_history(resource_type, resource_id, created_at DESC);

CREATE TABLE IF NOT EXISTS trade_attachments (
  id TEXT PRIMARY KEY,
  trade_id TEXT NOT NULL,
  file_name TEXT NOT NULL,
  mime_type TEXT NOT NULL,
  byte_size INTEGER NOT NULL,
  image_data BLOB NOT NULL,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_trade_attachments_trade_id ON trade_attachments(trade_id, created_at);

CREATE TABLE IF NOT EXISTS deleted_trades (
  trade_id TEXT PRIMARY KEY,
  deleted_by TEXT NOT NULL,
  deleted_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_deleted_trades_deleted_at ON deleted_trades(deleted_at);

CREATE TABLE IF NOT EXISTS articles (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  content_md TEXT NOT NULL,
  excerpt TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL CHECK (status IN ('draft', 'final')),
  tags_json TEXT NOT NULL DEFAULT '[]',
  trade_ids_json TEXT NOT NULL DEFAULT '[]',
  revision INTEGER NOT NULL DEFAULT 1,
  created_by TEXT NOT NULL,
  updated_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT,
  deleted_by TEXT
);

CREATE INDEX IF NOT EXISTS idx_articles_updated_at ON articles(deleted_at, updated_at DESC);

CREATE TABLE IF NOT EXISTS article_versions (
  article_id TEXT NOT NULL,
  revision INTEGER NOT NULL,
  title TEXT NOT NULL,
  content_md TEXT NOT NULL,
  status TEXT NOT NULL,
  tags_json TEXT NOT NULL,
  trade_ids_json TEXT NOT NULL,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (article_id, revision),
  FOREIGN KEY (article_id) REFERENCES articles(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_article_versions_article ON article_versions(article_id, revision DESC);

CREATE TABLE IF NOT EXISTS article_images (
  id TEXT PRIMARY KEY,
  article_id TEXT NOT NULL,
  file_name TEXT NOT NULL,
  mime_type TEXT NOT NULL,
  byte_size INTEGER NOT NULL,
  image_data BLOB NOT NULL,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY (article_id) REFERENCES articles(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_article_images_article ON article_images(article_id, created_at);

CREATE TABLE IF NOT EXISTS article_trade_links (
  article_id TEXT NOT NULL,
  trade_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (article_id, trade_id),
  FOREIGN KEY (article_id) REFERENCES articles(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_article_trade_links_trade ON article_trade_links(trade_id, article_id);

CREATE TABLE IF NOT EXISTS article_audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  article_id TEXT NOT NULL,
  action TEXT NOT NULL,
  actor TEXT NOT NULL,
  detail TEXT,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_article_audit_created_at ON article_audit_log(article_id, created_at DESC);
