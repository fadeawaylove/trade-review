import {
  MAX_ARTICLE_IMAGE_BYTES,
  MAX_ARTICLE_IMAGES,
  articleExcerpt,
  cleanArticlePayload,
  parseArticleRow,
  parseArticleVersionRow,
} from "./article-domain.js";

const uuidPart = "([0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})";
const allowedImageTypes = new Set(["image/png", "image/jpeg", "image/webp"]);

const articleColumns = "id, title, content_md, excerpt, status, tags_json, trade_ids_json, revision, created_by, updated_by, created_at, updated_at, deleted_at";
const summaryColumns = "id, title, excerpt, status, tags_json, trade_ids_json, revision, created_by, updated_by, created_at, updated_at, deleted_at";
const qualifiedSummaryColumns = summaryColumns.split(", ").map((column) => `a.${column}`).join(", ");

function cleanFileName(value) {
  return decodeURIComponent(String(value || "随笔图片")).replace(/[\\/:*?"<>|\u0000-\u001f]/g, "_").trim().slice(0, 120) || "随笔图片";
}

function imageMeta(row) {
  return {
    id: row.id,
    articleId: row.article_id,
    fileName: row.file_name,
    mimeType: row.mime_type,
    byteSize: Number(row.byte_size || 0),
    createdBy: row.created_by,
    createdAt: row.created_at,
  };
}

function versionInsert(env, articleId, revision, value, actor, now) {
  return env.DB.prepare("INSERT INTO article_versions (article_id, revision, title, content_md, status, tags_json, trade_ids_json, created_by, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)")
    .bind(articleId, revision, value.title, value.contentMd, value.status, JSON.stringify(value.tags), JSON.stringify(value.tradeIds), actor, now);
}

function linkStatements(env, articleId, tradeIds, now) {
  return [
    env.DB.prepare("DELETE FROM article_trade_links WHERE article_id = ?1").bind(articleId),
    ...tradeIds.map((tradeId) => env.DB.prepare("INSERT INTO article_trade_links (article_id, trade_id, created_at) VALUES (?1, ?2, ?3)").bind(articleId, tradeId, now)),
  ];
}

function auditStatement(env, articleId, action, actor, now, detail = null) {
  return env.DB.prepare("INSERT INTO article_audit_log (article_id, action, actor, detail, created_at) VALUES (?1, ?2, ?3, ?4, ?5)")
    .bind(articleId, action, actor, detail, now);
}

async function ensureTradesExist(env, tradeIds) {
  if (!tradeIds.length) return;
  const row = await env.DB.prepare("SELECT payload FROM dataset WHERE id = 1").first();
  const trades = row ? JSON.parse(row.payload || "{}").trades || [] : [];
  const existing = new Set(trades.map((trade) => trade.tradeId));
  const missing = tradeIds.filter((tradeId) => !existing.has(tradeId));
  if (missing.length) throw new Error(`关联交易不存在：${missing.join("、")}`);
}

async function articleWithAssets(env, articleId, { includeDeleted = false, onlyReferencedImages = false } = {}) {
  const row = await env.DB.prepare(`SELECT ${articleColumns} FROM articles WHERE id = ?1${includeDeleted ? "" : " AND deleted_at IS NULL"}`).bind(articleId).first();
  if (!row) return null;
  const imageSql = onlyReferencedImages
    ? "SELECT i.id, i.article_id, i.file_name, i.mime_type, i.byte_size, i.created_by, i.created_at FROM article_images i JOIN articles a ON a.id = i.article_id WHERE i.article_id = ?1 AND a.deleted_at IS NULL AND instr(a.content_md, 'article-image:' || i.id) > 0 ORDER BY i.created_at"
    : "SELECT id, article_id, file_name, mime_type, byte_size, created_by, created_at FROM article_images WHERE article_id = ?1 ORDER BY created_at";
  const images = await env.DB.prepare(imageSql).bind(articleId).all();
  return { ...parseArticleRow(row), images: (images.results || []).map(imageMeta) };
}

async function updateArticle(env, user, articleId, payload, { action = "update", detail = null } = {}) {
  const existing = await env.DB.prepare(`SELECT ${articleColumns} FROM articles WHERE id = ?1 AND deleted_at IS NULL`).bind(articleId).first();
  if (!existing) return { status: 404, error: "随笔不存在或已在回收站" };
  const cleaned = cleanArticlePayload(payload, { requireRevision: true });
  if (Number(existing.revision) !== cleaned.revision) return { status: 409, error: "随笔已在其他页面更新，请刷新后再保存" };
  await ensureTradesExist(env, cleaned.tradeIds);
  const nextRevision = cleaned.revision + 1;
  const now = new Date().toISOString();
  const updated = await env.DB.prepare("UPDATE articles SET title = ?1, content_md = ?2, excerpt = ?3, status = ?4, tags_json = ?5, trade_ids_json = ?6, revision = ?7, updated_by = ?8, updated_at = ?9 WHERE id = ?10 AND revision = ?11 AND deleted_at IS NULL")
    .bind(cleaned.title, cleaned.contentMd, articleExcerpt(cleaned.contentMd), cleaned.status, JSON.stringify(cleaned.tags), JSON.stringify(cleaned.tradeIds), nextRevision, user.login, now, articleId, cleaned.revision)
    .run();
  if (Number(updated.meta?.changes || 0) !== 1) return { status: 409, error: "随笔已在其他页面更新，请刷新后再保存" };
  await env.DB.batch([
    versionInsert(env, articleId, nextRevision, cleaned, user.login, now),
    ...linkStatements(env, articleId, cleaned.tradeIds, now),
    auditStatement(env, articleId, action, user.login, now, detail),
  ]);
  return { status: 200, article: await articleWithAssets(env, articleId) };
}

export async function handleArticleRequest(request, env, user, url, helpers) {
  const { json, binaryHeaders, corsHeaders } = helpers;
  const path = url.pathname;

  if (path === "/api/articles" && request.method === "GET") {
    const deleted = url.searchParams.get("deleted") === "1";
    if (deleted && user.role !== "editor") return json(request, env, { error: "当前账号无权查看随笔回收站" }, 403);
    const rows = await env.DB.prepare(`SELECT ${summaryColumns} FROM articles WHERE deleted_at IS ${deleted ? "NOT " : ""}NULL ORDER BY updated_at DESC`).all();
    return json(request, env, { articles: (rows.results || []).map((row) => parseArticleRow(row, { includeContent: false })) });
  }

  if (path === "/api/articles" && request.method === "POST") {
    try {
      const cleaned = cleanArticlePayload(await request.json());
      await ensureTradesExist(env, cleaned.tradeIds);
      const id = crypto.randomUUID();
      const now = new Date().toISOString();
      await env.DB.batch([
        env.DB.prepare("INSERT INTO articles (id, title, content_md, excerpt, status, tags_json, trade_ids_json, revision, created_by, updated_by, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 1, ?8, ?8, ?9, ?9)")
          .bind(id, cleaned.title, cleaned.contentMd, articleExcerpt(cleaned.contentMd), cleaned.status, JSON.stringify(cleaned.tags), JSON.stringify(cleaned.tradeIds), user.login, now),
        versionInsert(env, id, 1, cleaned, user.login, now),
        ...cleaned.tradeIds.map((tradeId) => env.DB.prepare("INSERT INTO article_trade_links (article_id, trade_id, created_at) VALUES (?1, ?2, ?3)").bind(id, tradeId, now)),
        auditStatement(env, id, "create", user.login, now),
      ]);
      return json(request, env, { ok: true, article: await articleWithAssets(env, id) }, 201);
    } catch (error) { return json(request, env, { error: error.message || "新建随笔失败" }, 400); }
  }

  if (path === "/api/articles/export" && request.method === "GET") {
    if (user.role !== "editor") return json(request, env, { error: "当前账号无权导出完整随笔备份" }, 403);
    const rows = await env.DB.prepare(`SELECT ${articleColumns} FROM articles ORDER BY created_at`).all();
    const versions = await env.DB.prepare("SELECT article_id, revision, title, content_md, status, tags_json, trade_ids_json, created_by, created_at FROM article_versions ORDER BY article_id, revision").all();
    const images = await env.DB.prepare("SELECT id, article_id, file_name, mime_type, byte_size, created_by, created_at FROM article_images ORDER BY article_id, created_at").all();
    return json(request, env, {
      schemaVersion: 1,
      exportedAt: new Date().toISOString(),
      articles: (rows.results || []).map((row) => parseArticleRow(row)),
      versions: (versions.results || []).map((row) => parseArticleVersionRow(row, { includeContent: true })),
      images: (images.results || []).map(imageMeta),
    }, 200, { "Content-Disposition": "attachment; filename=trade-review-articles.json" });
  }

  const articleItem = path.match(new RegExp(`^/api/articles/${uuidPart}$`, "i"));
  if (articleItem && request.method === "GET") {
    const includeDeleted = url.searchParams.get("deleted") === "1";
    if (includeDeleted && user.role !== "editor") return json(request, env, { error: "当前账号无权查看回收站随笔" }, 403);
    const article = await articleWithAssets(env, articleItem[1], { includeDeleted, onlyReferencedImages: user.role !== "editor" });
    return article ? json(request, env, { article }) : json(request, env, { error: "随笔不存在" }, 404);
  }
  if (articleItem && request.method === "PUT") {
    try {
      const result = await updateArticle(env, user, articleItem[1], await request.json());
      return result.article ? json(request, env, { ok: true, article: result.article }) : json(request, env, { error: result.error }, result.status);
    } catch (error) { return json(request, env, { error: error.message || "保存随笔失败" }, 400); }
  }
  if (articleItem && request.method === "DELETE") {
    const now = new Date().toISOString();
    const result = await env.DB.prepare("UPDATE articles SET deleted_at = ?1, deleted_by = ?2, updated_at = ?1, updated_by = ?2 WHERE id = ?3 AND deleted_at IS NULL")
      .bind(now, user.login, articleItem[1]).run();
    if (!Number(result.meta?.changes || 0)) return json(request, env, { error: "随笔不存在或已在回收站" }, 404);
    await auditStatement(env, articleItem[1], "delete", user.login, now).run();
    return json(request, env, { ok: true, articleId: articleItem[1], deletedAt: now });
  }

  const restoreItem = path.match(new RegExp(`^/api/articles/${uuidPart}/restore$`, "i"));
  if (restoreItem && request.method === "POST") {
    const now = new Date().toISOString();
    const result = await env.DB.prepare("UPDATE articles SET deleted_at = NULL, deleted_by = NULL, updated_at = ?1, updated_by = ?2 WHERE id = ?3 AND deleted_at IS NOT NULL")
      .bind(now, user.login, restoreItem[1]).run();
    if (!Number(result.meta?.changes || 0)) return json(request, env, { error: "回收站中没有这篇随笔" }, 404);
    await auditStatement(env, restoreItem[1], "restore", user.login, now).run();
    return json(request, env, { ok: true, article: await articleWithAssets(env, restoreItem[1]) });
  }

  const versions = path.match(new RegExp(`^/api/articles/${uuidPart}/versions$`, "i"));
  if (versions && request.method === "GET") {
    if (user.role !== "editor") return json(request, env, { error: "当前账号无权查看随笔历史版本" }, 403);
    const rows = await env.DB.prepare("SELECT article_id, revision, title, status, tags_json, trade_ids_json, created_by, created_at FROM article_versions WHERE article_id = ?1 ORDER BY revision DESC").bind(versions[1]).all();
    return json(request, env, { versions: (rows.results || []).map((row) => parseArticleVersionRow(row)) });
  }

  const versionItem = path.match(new RegExp(`^/api/articles/${uuidPart}/versions/(\\d+)$`, "i"));
  if (versionItem && request.method === "GET") {
    if (user.role !== "editor") return json(request, env, { error: "当前账号无权查看随笔历史版本" }, 403);
    const row = await env.DB.prepare("SELECT article_id, revision, title, content_md, status, tags_json, trade_ids_json, created_by, created_at FROM article_versions WHERE article_id = ?1 AND revision = ?2").bind(versionItem[1], Number(versionItem[2])).first();
    return row ? json(request, env, { version: parseArticleVersionRow(row, { includeContent: true }) }) : json(request, env, { error: "历史版本不存在" }, 404);
  }

  const versionRestore = path.match(new RegExp(`^/api/articles/${uuidPart}/versions/(\\d+)/restore$`, "i"));
  if (versionRestore && request.method === "POST") {
    try {
      const current = await env.DB.prepare(`SELECT ${articleColumns} FROM articles WHERE id = ?1 AND deleted_at IS NULL`).bind(versionRestore[1]).first();
      const historical = await env.DB.prepare("SELECT article_id, revision, title, content_md, status, tags_json, trade_ids_json, created_by, created_at FROM article_versions WHERE article_id = ?1 AND revision = ?2").bind(versionRestore[1], Number(versionRestore[2])).first();
      if (!current || !historical) return json(request, env, { error: "随笔或历史版本不存在" }, 404);
      const old = parseArticleVersionRow(historical, { includeContent: true });
      const result = await updateArticle(env, user, versionRestore[1], { ...old, revision: Number(current.revision) }, { action: "restore-version", detail: `revision:${old.revision}` });
      return result.article ? json(request, env, { ok: true, article: result.article }) : json(request, env, { error: result.error }, result.status);
    } catch (error) { return json(request, env, { error: error.message || "恢复历史版本失败" }, 400); }
  }

  const imageCollection = path.match(new RegExp(`^/api/articles/${uuidPart}/images$`, "i"));
  if (imageCollection && request.method === "POST") {
    try {
      const article = await env.DB.prepare("SELECT id FROM articles WHERE id = ?1 AND deleted_at IS NULL").bind(imageCollection[1]).first();
      if (!article) return json(request, env, { error: "随笔不存在" }, 404);
      const count = await env.DB.prepare("SELECT COUNT(*) AS count FROM article_images WHERE article_id = ?1").bind(imageCollection[1]).first();
      if (Number(count?.count || 0) >= MAX_ARTICLE_IMAGES) return json(request, env, { error: `每篇随笔最多 ${MAX_ARTICLE_IMAGES} 张图片` }, 409);
      const mimeType = (request.headers.get("Content-Type") || "").split(";")[0].toLowerCase();
      if (!allowedImageTypes.has(mimeType)) return json(request, env, { error: "仅支持 PNG、JPEG 或 WebP 图片" }, 415);
      const bytes = await request.arrayBuffer();
      if (!bytes.byteLength) return json(request, env, { error: "图片内容为空" }, 400);
      if (bytes.byteLength > MAX_ARTICLE_IMAGE_BYTES) return json(request, env, { error: "图片超过 1.7 MB，请压缩后重试" }, 413);
      const id = crypto.randomUUID();
      const now = new Date().toISOString();
      const fileName = cleanFileName(request.headers.get("X-File-Name"));
      await env.DB.batch([
        env.DB.prepare("INSERT INTO article_images (id, article_id, file_name, mime_type, byte_size, image_data, created_by, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)").bind(id, imageCollection[1], fileName, mimeType, bytes.byteLength, bytes, user.login, now),
        auditStatement(env, imageCollection[1], "image-upload", user.login, now, id),
      ]);
      return json(request, env, { ok: true, image: imageMeta({ id, article_id: imageCollection[1], file_name: fileName, mime_type: mimeType, byte_size: bytes.byteLength, created_by: user.login, created_at: now }), markdown: `![${fileName}](article-image:${id})` }, 201);
    } catch (error) { return json(request, env, { error: error.message || "上传随笔图片失败" }, 400); }
  }

  const imageItem = path.match(new RegExp(`^/api/article-images/${uuidPart}$`, "i"));
  if (imageItem && request.method === "GET") {
    const sql = user.role === "editor"
      ? "SELECT mime_type, byte_size, image_data FROM article_images WHERE id = ?1"
      : "SELECT i.mime_type, i.byte_size, i.image_data FROM article_images i JOIN articles a ON a.id = i.article_id WHERE i.id = ?1 AND a.deleted_at IS NULL AND instr(a.content_md, 'article-image:' || i.id) > 0";
    const row = await env.DB.prepare(sql).bind(imageItem[1]).first();
    if (!row) return json(request, env, { error: "随笔图片不存在" }, 404);
    return new Response(new Uint8Array(row.image_data), { status: 200, headers: binaryHeaders(request, env, row.mime_type, row.byte_size) });
  }
  if (imageItem && request.method === "DELETE") {
    const row = await env.DB.prepare("SELECT article_id FROM article_images WHERE id = ?1").bind(imageItem[1]).first();
    if (!row) return json(request, env, { error: "随笔图片不存在" }, 404);
    const now = new Date().toISOString();
    await env.DB.batch([
      env.DB.prepare("DELETE FROM article_images WHERE id = ?1").bind(imageItem[1]),
      auditStatement(env, row.article_id, "image-delete", user.login, now, imageItem[1]),
    ]);
    return json(request, env, { ok: true, articleId: row.article_id });
  }

  const tradeArticles = path.match(/^\/api\/trades\/(TR-\d+)\/articles$/i);
  if (tradeArticles && request.method === "GET") {
    const rows = await env.DB.prepare(`SELECT ${qualifiedSummaryColumns} FROM articles a JOIN article_trade_links l ON l.article_id = a.id WHERE l.trade_id = ?1 AND a.deleted_at IS NULL ORDER BY a.updated_at DESC`).bind(tradeArticles[1].toUpperCase()).all();
    return json(request, env, { articles: (rows.results || []).map((row) => parseArticleRow(row, { includeContent: false })) });
  }

  if (path.startsWith("/api/articles") || path.startsWith("/api/article-images")) return json(request, env, { error: "随笔接口不存在" }, 404);
  return null;
}
