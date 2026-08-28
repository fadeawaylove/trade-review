export function articleSearchQuery(value) {
  const query = String(value || "").trim().slice(0, 200);
  return query ? `"${query.replace(/"/g, '""')}"` : "";
}

export function articleSearchNeedle(value) {
  const query = String(value || "").normalize("NFKC").trim().slice(0, 200).toLocaleLowerCase("zh-CN");
  return query ? `%${query.replace(/[\\%_]/g, (character) => `\\${character}`)}%` : "";
}

export function replaceWorkingArticleSearchStatements(env, articleId) {
  return [
    env.DB.prepare("DELETE FROM article_working_fts WHERE article_id = ?1").bind(articleId),
    env.DB.prepare(`INSERT INTO article_working_fts (article_id, title, summary, content_md, tags)
      SELECT id, title, summary, content_md, tags_json
      FROM articles
      WHERE id = ?1 AND deleted_at IS NULL`).bind(articleId),
  ];
}

export function removePublicArticleSearchStatement(env, articleId) {
  return env.DB.prepare("DELETE FROM article_public_fts WHERE article_id = ?1").bind(articleId);
}

export function replacePublicArticleSearchStatements(env, articleId) {
  return [
    removePublicArticleSearchStatement(env, articleId),
    env.DB.prepare(`INSERT INTO article_public_fts (article_id, slug, title, summary, tags, content_text)
      SELECT a.id, v.slug, '', '', '', v.public_search_text
      FROM articles a
      JOIN article_versions v ON v.article_id = a.id AND v.revision = a.published_revision
      WHERE a.id = ?1
        AND a.deleted_at IS NULL
        AND a.visibility = 'public'
        AND a.published_revision IS NOT NULL`).bind(articleId),
  ];
}
