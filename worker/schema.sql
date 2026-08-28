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

-- Each authorized GitHub account keeps an independent silver target anchor.
-- Nullable prices preserve partially completed forms across devices.
CREATE TABLE IF NOT EXISTS silver_target_settings (
  login TEXT PRIMARY KEY,
  contract TEXT NOT NULL DEFAULT '',
  xag_anchor REAL CHECK (xag_anchor IS NULL OR xag_anchor > 0),
  ag_anchor REAL CHECK (ag_anchor IS NULL OR ag_anchor > 0),
  xag_target REAL CHECK (xag_target IS NULL OR xag_target > 0),
  tolerance_percent REAL NOT NULL DEFAULT 0.5 CHECK (tolerance_percent >= 0 AND tolerance_percent <= 10),
  updated_at TEXT NOT NULL
);

-- Shared, validated market quotes. Personal settings above are never overwritten by this feed.
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

-- Per-account contract selection. Missing legacy rows deliberately resolve from
-- silver_target_settings: a valid old contract means manual, otherwise auto.
CREATE TABLE IF NOT EXISTS silver_target_contract_preferences (
  login TEXT PRIMARY KEY,
  mode TEXT NOT NULL CHECK (mode IN ('auto', 'manual')),
  updated_at TEXT NOT NULL
);

-- One global, monotonic AG main-contract state. The hour-bucket fields make
-- repeated Cron deliveries and concurrent retries idempotent.
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

-- New JWTs can be revoked immediately when the user explicitly logs out.
-- Legacy JWTs without a jti remain valid until their original expiration.
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

-- Rebuild the table so earlier deployments whose CHECK constraint only allowed
-- trade/article can accept dashboard page views without losing existing rows.
CREATE TABLE IF NOT EXISTS access_history_next (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  actor TEXT NOT NULL,
  resource_type TEXT NOT NULL CHECK (resource_type IN ('dashboard', 'trade', 'article')),
  resource_id TEXT NOT NULL,
  action TEXT NOT NULL CHECK (action IN ('view')),
  title TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL
);

INSERT OR IGNORE INTO access_history_next (id, actor, resource_type, resource_id, action, title, created_at)
  SELECT id, actor, resource_type, resource_id, action, title, created_at FROM access_history;

DROP TABLE access_history;
ALTER TABLE access_history_next RENAME TO access_history;

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

-- Keep deleted trades recoverable for 30 days. Overrides and chart evidence remain
-- untouched until a manual or scheduled permanent purge removes all related data.
CREATE TABLE IF NOT EXISTS deleted_trades (
  trade_id TEXT PRIMARY KEY,
  deleted_by TEXT NOT NULL,
  deleted_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_deleted_trades_deleted_at ON deleted_trades(deleted_at);

-- Private Markdown essays are stored outside the public Pages repository.
CREATE TABLE IF NOT EXISTS articles (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  summary TEXT NOT NULL DEFAULT '',
  slug TEXT,
  content_md TEXT NOT NULL,
  excerpt TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL CHECK (status IN ('draft', 'final')),
  visibility TEXT NOT NULL DEFAULT 'private' CHECK (visibility IN ('private', 'public')),
  cover_image_id TEXT,
  tags_json TEXT NOT NULL DEFAULT '[]',
  trade_ids_json TEXT NOT NULL DEFAULT '[]',
  revision INTEGER NOT NULL DEFAULT 1,
  public_search_text TEXT NOT NULL DEFAULT '',
  published_revision INTEGER,
  published_at TEXT,
  created_by TEXT NOT NULL,
  updated_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT,
  deleted_by TEXT
);

CREATE INDEX IF NOT EXISTS idx_articles_updated_at ON articles(deleted_at, updated_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS idx_articles_slug ON articles(slug COLLATE NOCASE) WHERE slug IS NOT NULL AND slug <> '';
CREATE INDEX IF NOT EXISTS idx_articles_publication ON articles(visibility, deleted_at, published_at DESC);

CREATE TABLE IF NOT EXISTS article_versions (
  article_id TEXT NOT NULL,
  revision INTEGER NOT NULL,
  title TEXT NOT NULL,
  summary TEXT NOT NULL DEFAULT '',
  slug TEXT,
  content_md TEXT NOT NULL,
  status TEXT NOT NULL,
  cover_image_id TEXT,
  tags_json TEXT NOT NULL,
  trade_ids_json TEXT NOT NULL,
  public_search_text TEXT NOT NULL DEFAULT '',
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

-- Authoritative v2 projection derived from Markdown. The legacy table remains
-- untouched so old caller-provided associations stay auditable but are never read.
CREATE TABLE IF NOT EXISTS article_trade_links_derived (
  article_id TEXT NOT NULL,
  trade_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (article_id, trade_id),
  FOREIGN KEY (article_id) REFERENCES articles(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_article_trade_links_derived_trade
  ON article_trade_links_derived(trade_id, article_id);

CREATE TABLE IF NOT EXISTS article_audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  article_id TEXT NOT NULL,
  action TEXT NOT NULL,
  actor TEXT NOT NULL,
  detail TEXT,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_article_audit_created_at ON article_audit_log(article_id, created_at DESC);

-- Separate projections prevent private working-copy edits from leaking into
-- public search before the editor explicitly publishes a checkpoint.
CREATE VIRTUAL TABLE IF NOT EXISTS article_working_fts USING fts5(
  article_id UNINDEXED,
  title,
  summary,
  content_md,
  tags,
  tokenize = 'unicode61'
);

CREATE VIRTUAL TABLE IF NOT EXISTS article_public_fts USING fts5(
  article_id UNINDEXED,
  slug UNINDEXED,
  title,
  summary,
  tags,
  content_text,
  tokenize = 'unicode61'
);

CREATE TRIGGER IF NOT EXISTS articles_working_fts_after_insert
AFTER INSERT ON articles
BEGIN
  INSERT INTO article_working_fts (article_id, title, summary, content_md, tags)
    SELECT NEW.id, NEW.title, NEW.summary, NEW.content_md, NEW.tags_json
    WHERE NEW.deleted_at IS NULL;
END;


-- Derived trade links are a transaction-local projection of the canonical
-- server-computed JSON. Triggers prevent a slower request from overwriting a
-- newer revision's reverse links after its compare-and-swap UPDATE succeeds.
CREATE TRIGGER IF NOT EXISTS articles_trade_links_after_insert
AFTER INSERT ON articles
BEGIN
  DELETE FROM article_trade_links_derived WHERE article_id = NEW.id;
  INSERT OR IGNORE INTO article_trade_links_derived (article_id, trade_id, created_at)
    SELECT NEW.id, upper(trim(CAST(value AS TEXT))), NEW.updated_at
    FROM json_each(CASE WHEN json_valid(NEW.trade_ids_json) THEN NEW.trade_ids_json ELSE '[]' END)
    WHERE NEW.deleted_at IS NULL
      AND upper(trim(CAST(value AS TEXT))) LIKE 'TR-%'
      AND length(substr(upper(trim(CAST(value AS TEXT))), 4)) >= 4
      AND substr(upper(trim(CAST(value AS TEXT))), 4) NOT GLOB '*[^0-9]*';
END;

CREATE TRIGGER IF NOT EXISTS articles_trade_links_after_update
AFTER UPDATE OF trade_ids_json, deleted_at ON articles
BEGIN
  DELETE FROM article_trade_links_derived WHERE article_id = NEW.id;
  INSERT OR IGNORE INTO article_trade_links_derived (article_id, trade_id, created_at)
    SELECT NEW.id, upper(trim(CAST(value AS TEXT))), NEW.updated_at
    FROM json_each(CASE WHEN json_valid(NEW.trade_ids_json) THEN NEW.trade_ids_json ELSE '[]' END)
    WHERE NEW.deleted_at IS NULL
      AND upper(trim(CAST(value AS TEXT))) LIKE 'TR-%'
      AND length(substr(upper(trim(CAST(value AS TEXT))), 4)) >= 4
      AND substr(upper(trim(CAST(value AS TEXT))), 4) NOT GLOB '*[^0-9]*';
END;
CREATE TRIGGER IF NOT EXISTS articles_working_fts_after_update
AFTER UPDATE OF title, summary, content_md, tags_json, deleted_at ON articles
BEGIN
  DELETE FROM article_working_fts WHERE article_id = NEW.id;
  INSERT INTO article_working_fts (article_id, title, summary, content_md, tags)
    SELECT NEW.id, NEW.title, NEW.summary, NEW.content_md, NEW.tags_json
    WHERE NEW.deleted_at IS NULL;
END;

-- Publishing is one conditional UPDATE. The current revision is snapshotted and
-- only public metadata is copied into the search projection in the same transaction.
CREATE TRIGGER IF NOT EXISTS articles_public_snapshot_after_update
AFTER UPDATE OF visibility, published_revision, deleted_at ON articles
BEGIN
  DELETE FROM article_public_fts WHERE article_id = NEW.id;
  INSERT OR REPLACE INTO article_versions (
    article_id, revision, title, summary, slug, content_md, status,
    cover_image_id, tags_json, trade_ids_json, public_search_text, created_by, created_at
  )
    SELECT NEW.id, NEW.revision, NEW.title, NEW.summary, NEW.slug, NEW.content_md,
      'final', NEW.cover_image_id, NEW.tags_json, NEW.trade_ids_json, NEW.public_search_text,
      NEW.updated_by, NEW.updated_at
    WHERE NEW.deleted_at IS NULL
      AND NEW.visibility = 'public'
      AND NEW.published_revision = NEW.revision;
  INSERT INTO article_public_fts (article_id, slug, title, summary, tags, content_text)
    SELECT NEW.id, NEW.slug, '', '', '', NEW.public_search_text
    WHERE NEW.deleted_at IS NULL
      AND NEW.visibility = 'public'
      AND NEW.published_revision = NEW.revision;
END;
