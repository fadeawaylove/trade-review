import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import test from "node:test";
import { Miniflare } from "miniflare";

async function executeSql(db, sql) {
  const statements = [];
  let current = [];
  let trigger = false;
  for (const sourceLine of String(sql || "").replaceAll("\r", "").split("\n")) {
    const line = sourceLine.trim();
    if (!line || line.startsWith("--")) continue;
    if (!current.length) trigger = /^CREATE\s+TRIGGER\b/i.test(line);
    current.push(line);
    const complete = trigger ? /^END;$/i.test(line) : /;$/.test(line);
    if (!complete) continue;
    statements.push(current.join(" "));
    current = [];
    trigger = false;
  }
  if (current.length) throw new Error("测试 SQL 包含未闭合的语句");
  await db.exec(statements.join("\n"));
}

test("真实 D1 trigger 隔离工作副本、公开快照与派生交易关联", async () => {
  const miniflare = new Miniflare({
    modules: true,
    script: "export default { fetch() { return new Response('ok'); } }",
    d1Databases: { DB: "journal-v2-trigger-test" },
  });
  try {
    const db = await miniflare.getD1Database("DB");
    const schema = await fs.readFile(new URL("../worker/schema.sql", import.meta.url), "utf8");
    await executeSql(db, schema);
    const articleId = "22222222-2222-4222-8222-222222222222";
    await db.prepare(`INSERT INTO articles (
      id, title, summary, slug, content_md, excerpt, status, visibility,
      tags_json, trade_ids_json, revision, created_by, updated_by, created_at, updated_at
    ) VALUES (?1, '发布标题', '', 'journal-trigger', '旧的公开正文', '', 'draft', 'private',
      '["纪律"]', '["TR-0001"]', 1, 'editor', 'editor', ?2, ?2)`)
      .bind(articleId, "2026-08-01T00:00:00.000Z")
      .run();

    await db.prepare(`UPDATE articles
      SET status = 'final', visibility = 'public', public_search_text = '旧的公开正文',
        published_revision = 1, published_at = ?1, updated_at = ?1
      WHERE id = ?2 AND revision = 1`)
      .bind("2026-08-02T00:00:00.000Z", articleId)
      .run();

    const published = await db.prepare(`SELECT v.title, v.content_md, v.revision
      FROM articles a JOIN article_versions v
        ON v.article_id = a.id AND v.revision = a.published_revision
      WHERE a.id = ?1 AND a.visibility = 'public'`).bind(articleId).first();
    assert.deepEqual(published, { title: "发布标题", content_md: "旧的公开正文", revision: 1 });
    assert.equal((await db.prepare("SELECT COUNT(*) AS count FROM article_public_fts WHERE article_id = ?1 AND content_text = '旧的公开正文'").bind(articleId).first()).count, 1);

    await db.prepare(`UPDATE articles
      SET title = '私密工作标题', content_md = '尚未再次发布的私密修改',
        trade_ids_json = '["TR-0002"]', revision = 2, updated_at = ?1
      WHERE id = ?2 AND revision = 1`)
      .bind("2026-08-03T00:00:00.000Z", articleId)
      .run();

    const stillPublished = await db.prepare(`SELECT v.title, v.content_md, v.revision
      FROM articles a JOIN article_versions v
        ON v.article_id = a.id AND v.revision = a.published_revision
      WHERE a.id = ?1 AND a.visibility = 'public'`).bind(articleId).first();
    assert.deepEqual(stillPublished, published);
    assert.equal((await db.prepare("SELECT COUNT(*) AS count FROM article_public_fts WHERE article_id = ?1 AND content_text LIKE '%私密修改%'").bind(articleId).first()).count, 0);
    const derivedLinks = await db.prepare("SELECT trade_id FROM article_trade_links_derived WHERE article_id = ?1 ORDER BY trade_id").bind(articleId).all();
    assert.deepEqual(derivedLinks.results, [{ trade_id: "TR-0002" }]);

    await db.prepare("UPDATE articles SET visibility = 'private' WHERE id = ?1").bind(articleId).run();
    assert.equal((await db.prepare("SELECT COUNT(*) AS count FROM article_public_fts WHERE article_id = ?1").bind(articleId).first()).count, 0);
    assert.equal((await db.prepare("SELECT COUNT(*) AS count FROM article_versions WHERE article_id = ?1").bind(articleId).first()).count, 1);
  } finally {
    await miniflare.dispose();
  }
});
