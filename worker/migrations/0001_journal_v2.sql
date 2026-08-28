-- Keep this migration LF-only: Wrangler remote migrations misparse CRLF trigger bodies.
-- Journal v2 keeps working copies private by default and publishes immutable
-- article_versions snapshots. Wrangler records this migration after a successful
-- apply, so the ALTER statements run once per D1 database.
ALTER TABLE articles ADD COLUMN summary TEXT NOT NULL DEFAULT '';
ALTER TABLE articles ADD COLUMN slug TEXT;
ALTER TABLE articles ADD COLUMN visibility TEXT NOT NULL DEFAULT 'private' CHECK (visibility IN ('private', 'public'));
ALTER TABLE articles ADD COLUMN cover_image_id TEXT;
ALTER TABLE articles ADD COLUMN public_search_text TEXT NOT NULL DEFAULT '';
ALTER TABLE articles ADD COLUMN published_revision INTEGER;
ALTER TABLE articles ADD COLUMN published_at TEXT;

ALTER TABLE article_versions ADD COLUMN summary TEXT NOT NULL DEFAULT '';
ALTER TABLE article_versions ADD COLUMN slug TEXT;
ALTER TABLE article_versions ADD COLUMN cover_image_id TEXT;
ALTER TABLE article_versions ADD COLUMN public_search_text TEXT NOT NULL DEFAULT '';

-- Existing articles remain private. Their generated excerpts are a useful
-- initial summary while the editor has not supplied one explicitly.
UPDATE articles SET summary = excerpt WHERE summary = '' AND excerpt <> '';
UPDATE articles SET visibility = 'private' WHERE visibility IS NULL OR visibility <> 'private';

CREATE TABLE IF NOT EXISTS article_trade_links_derived (
  article_id TEXT NOT NULL,
  trade_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (article_id, trade_id),
  FOREIGN KEY (article_id) REFERENCES articles(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_article_trade_links_derived_trade
  ON article_trade_links_derived(trade_id, article_id);

-- v1 accepted caller-provided relation metadata, so some existing Markdown links
-- were never projected. Strip fenced and inline code before parsing canonical
-- links. The legacy caller-provided table remains untouched for audit purposes;
-- all v2 reads and writes use this authoritative derived projection.
WITH RECURSIVE
html_comments(article_id, updated_at, rest, clean) AS (
  SELECT id, updated_at, content_md, ''
  FROM articles
  UNION ALL
  SELECT
    article_id,
    updated_at,
    CASE
      WHEN instr(substr(rest, instr(rest, '<!--') + 4), '-->') > 0
        THEN substr(
          substr(rest, instr(rest, '<!--') + 4),
          instr(substr(rest, instr(rest, '<!--') + 4), '-->') + 3
        )
      ELSE ''
    END,
    clean || substr(rest, 1, instr(rest, '<!--') - 1) || ' '
  FROM html_comments
  WHERE instr(rest, '<!--') > 0
),
html_clean(article_id, updated_at, content_md) AS (
  SELECT article_id, updated_at, clean || rest
  FROM html_comments
  WHERE instr(rest, '<!--') = 0
),
backtick_fences(article_id, updated_at, rest, clean) AS (
  SELECT article_id, updated_at, content_md, ''
  FROM html_clean
  UNION ALL
  SELECT
    article_id,
    updated_at,
    CASE
      WHEN instr(substr(rest, instr(rest, '```') + 3), '```') > 0
        THEN substr(
          substr(rest, instr(rest, '```') + 3),
          instr(substr(rest, instr(rest, '```') + 3), '```') + 3
        )
      ELSE ''
    END,
    clean || substr(rest, 1, instr(rest, '```') - 1) || ' '
  FROM backtick_fences
  WHERE instr(rest, '```') > 0
),
backtick_clean(article_id, updated_at, content_md) AS (
  SELECT article_id, updated_at, clean || rest
  FROM backtick_fences
  WHERE instr(rest, '```') = 0
),
tilde_fences(article_id, updated_at, rest, clean) AS (
  SELECT article_id, updated_at, content_md, ''
  FROM backtick_clean
  UNION ALL
  SELECT
    article_id,
    updated_at,
    CASE
      WHEN instr(substr(rest, instr(rest, '~~~') + 3), '~~~') > 0
        THEN substr(
          substr(rest, instr(rest, '~~~') + 3),
          instr(substr(rest, instr(rest, '~~~') + 3), '~~~') + 3
        )
      ELSE ''
    END,
    clean || substr(rest, 1, instr(rest, '~~~') - 1) || ' '
  FROM tilde_fences
  WHERE instr(rest, '~~~') > 0
),
tilde_clean(article_id, updated_at, content_md) AS (
  SELECT article_id, updated_at, clean || rest
  FROM tilde_fences
  WHERE instr(rest, '~~~') = 0
),
inline_code(article_id, updated_at, rest, clean) AS (
  SELECT article_id, updated_at, content_md, ''
  FROM tilde_clean
  UNION ALL
  SELECT
    article_id,
    updated_at,
    CASE
      WHEN instr(substr(rest, instr(rest, '`') + 1), '`') > 0
        THEN substr(
          substr(rest, instr(rest, '`') + 1),
          instr(substr(rest, instr(rest, '`') + 1), '`') + 1
        )
      ELSE ''
    END,
    clean || substr(rest, 1, instr(rest, '`') - 1) || ' '
  FROM inline_code
  WHERE instr(rest, '`') > 0
),
inline_clean(article_id, updated_at, content_md) AS (
  SELECT article_id, updated_at, clean || rest
  FROM inline_code
  WHERE instr(rest, '`') = 0
),
markdown_images(article_id, updated_at, rest, clean) AS (
  SELECT article_id, updated_at, content_md, ''
  FROM inline_clean
  UNION ALL
  SELECT
    article_id,
    updated_at,
    CASE
      WHEN instr(substr(rest, instr(rest, '![') + 2), ')') > 0
        THEN substr(
          substr(rest, instr(rest, '![') + 2),
          instr(substr(rest, instr(rest, '![') + 2), ')') + 1
        )
      ELSE ''
    END,
    clean || substr(rest, 1, instr(rest, '![') - 1) || ' '
  FROM markdown_images
  WHERE instr(rest, '![') > 0
),
code_free_articles(article_id, updated_at, content_md) AS (
  SELECT article_id, updated_at, clean || rest
  FROM markdown_images
  WHERE instr(rest, '![') = 0
),
article_trade_refs(article_id, updated_at, rest, trade_id) AS (
  SELECT article_id, updated_at, content_md, NULL
  FROM code_free_articles
  UNION ALL
  SELECT
    article_id,
    updated_at,
    substr(
      rest,
      instr(lower(rest), '](trade:tr-') + length('](trade:tr-')
        + instr(substr(rest, instr(lower(rest), '](trade:tr-') + length('](trade:tr-')), ')')
    ),
    'TR-' || substr(
      substr(rest, instr(lower(rest), '](trade:tr-') + length('](trade:tr-')),
      1,
      instr(substr(rest, instr(lower(rest), '](trade:tr-') + length('](trade:tr-')), ')') - 1
    )
  FROM article_trade_refs
  WHERE instr(lower(rest), '](trade:tr-') > 0
    AND instr(substr(rest, instr(lower(rest), '](trade:tr-') + length('](trade:tr-')), ')') > 1
), normalized_article_trade_refs AS (
  SELECT article_id, updated_at,
    upper(CASE
      WHEN instr(trim(trade_id), ' ') > 0 THEN substr(trim(trade_id), 1, instr(trim(trade_id), ' ') - 1)
      ELSE trim(trade_id)
    END) AS trade_id
  FROM article_trade_refs
  WHERE trade_id IS NOT NULL
), valid_article_trade_refs AS (
  SELECT DISTINCT article_id, updated_at, trade_id
  FROM normalized_article_trade_refs
  WHERE trade_id IS NOT NULL
    AND length(substr(trade_id, 4)) >= 4
    AND substr(trade_id, 4) NOT GLOB '*[^0-9]*'
)
INSERT OR IGNORE INTO article_trade_links_derived (article_id, trade_id, created_at)
  SELECT article_id, trade_id, updated_at
  FROM valid_article_trade_refs;

UPDATE articles
SET trade_ids_json = coalesce((
  SELECT json_group_array(trade_id)
  FROM (
    SELECT trade_id
    FROM article_trade_links_derived
    WHERE article_id = articles.id
    ORDER BY trade_id
  )
), '[]');

CREATE UNIQUE INDEX IF NOT EXISTS idx_articles_slug
  ON articles(slug COLLATE NOCASE)
  WHERE slug IS NOT NULL AND slug <> '';
CREATE INDEX IF NOT EXISTS idx_articles_publication
  ON articles(visibility, deleted_at, published_at DESC);

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

DELETE FROM article_working_fts;
INSERT INTO article_working_fts (article_id, title, summary, content_md, tags)
  SELECT id, title, summary, content_md, tags_json
  FROM articles
  WHERE deleted_at IS NULL;

-- Every pre-v2 article is private, so the public projection intentionally starts empty.
DELETE FROM article_public_fts;

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
