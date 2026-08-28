import {
  MAX_ARTICLE_IMAGE_BYTES,
  MAX_ARTICLE_IMAGES,
  articleImageIdsFromMarkdown,
  articleExcerpt,
  cleanArticlePayload,
  parseArticleRow,
  parseArticleVersionRow,
  publicArticleSearchProjection,
  tradeIdsFromArticleMarkdown,
} from "./article-domain.js";
import {
  articleSearchNeedle,
  articleSearchQuery,
  removePublicArticleSearchStatement,
  replaceWorkingArticleSearchStatements,
} from "./article-search.js";

const uuidPart = "([0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})";
const allowedImageTypes = new Set(["image/png", "image/jpeg", "image/webp"]);

const articleColumns = "id, title, summary, slug, content_md, excerpt, status, visibility, cover_image_id, tags_json, trade_ids_json, revision, published_revision, published_at, created_by, updated_by, created_at, updated_at, deleted_at";
const summaryColumns = "id, title, summary, slug, excerpt, status, visibility, cover_image_id, tags_json, trade_ids_json, revision, published_revision, published_at, created_by, updated_by, created_at, updated_at, deleted_at";
const versionColumns = "article_id, revision, title, summary, slug, content_md, status, cover_image_id, tags_json, trade_ids_json, created_by, created_at";
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

function versionInsert(env, articleId, revision, value, actor, now, { conflict = "error" } = {}) {
  const verb = conflict === "ignore" ? "INSERT OR IGNORE" : conflict === "replace" ? "INSERT OR REPLACE" : "INSERT";
  return env.DB.prepare(`${verb} INTO article_versions (article_id, revision, title, summary, slug, content_md, status, cover_image_id, tags_json, trade_ids_json, public_search_text, created_by, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)`)
    .bind(articleId, revision, value.title, value.summary || "", value.slug || null, value.contentMd, value.status, value.coverImageId || null, JSON.stringify(value.tags), JSON.stringify(value.tradeIds), publicArticleSearchProjection(value), actor, now);
}

function auditStatement(env, articleId, action, actor, now, detail = null) {
  return env.DB.prepare("INSERT INTO article_audit_log (article_id, action, actor, detail, created_at) VALUES (?1, ?2, ?3, ?4, ?5)")
    .bind(articleId, action, actor, detail, now);
}

async function existingTradeIds(env, tradeIds, { allowMissing = [] } = {}) {
  if (!tradeIds.length) return [];
  const row = await env.DB.prepare("SELECT payload FROM dataset WHERE id = 1").first();
  const trades = row ? JSON.parse(row.payload || "{}").trades || [] : [];
  const existing = new Set(trades.map((trade) => trade.tradeId));
  const missing = tradeIds.filter((tradeId) => !existing.has(tradeId));
  const allowed = new Set(allowMissing.map((tradeId) => String(tradeId).toUpperCase()));
  const invalid = missing.filter((tradeId) => !allowed.has(tradeId));
  if (invalid.length) throw new Error(`关联交易不存在：${invalid.join("、")}`);
  return tradeIds.filter((tradeId) => existing.has(tradeId));
}

async function ensureCoverImageExists(env, articleId, coverImageId) {
  if (!coverImageId) return;
  const row = await env.DB.prepare("SELECT id FROM article_images WHERE id = ?1 AND article_id = ?2").bind(coverImageId, articleId).first();
  if (!row) throw new Error("随笔封面图片不存在或不属于当前文章");
}

async function ensurePublishedImagesExist(env, articleId, contentMd, coverImageId) {
  const referencedIds = [...new Set([
    coverImageId,
    ...articleImageIdsFromMarkdown(contentMd),
  ].filter(Boolean).map((imageId) => String(imageId).toLowerCase()))];
  if (!referencedIds.length) return;
  const rows = await env.DB.prepare("SELECT id FROM article_images WHERE article_id = ?1").bind(articleId).all();
  const availableIds = new Set((rows.results || []).map((row) => String(row.id).toLowerCase()));
  const missingIds = referencedIds.filter((imageId) => !availableIds.has(imageId));
  if (missingIds.length) throw new Error("随笔正文或封面引用的图片不存在或不属于当前文章");
}

async function ensureSlugAvailable(env, articleId, slug) {
  if (!slug) return;
  const row = await env.DB.prepare("SELECT id FROM articles WHERE slug = ?1 COLLATE NOCASE AND id <> ?2 LIMIT 1").bind(slug, articleId).first();
  if (row) throw new Error("公开链接已被其他随笔使用");
}

function requiredActionRevision(value) {
  const revision = Number(value?.revision);
  if (!Number.isInteger(revision) || revision < 1) throw new Error("操作随笔时必须提供有效版本号");
  return revision;
}

function autoPublishedSlug(articleId) {
  return String(articleId || "").replace(/-/g, "").slice(0, 12).toLowerCase();
}

async function articleWithAssets(env, articleId, { includeDeleted = false, onlyReferencedImages = false } = {}) {
  const row = await env.DB.prepare(`SELECT ${articleColumns} FROM articles WHERE id = ?1${includeDeleted ? "" : " AND deleted_at IS NULL"}`).bind(articleId).first();
  if (!row) return null;
  const images = await env.DB.prepare("SELECT id, article_id, file_name, mime_type, byte_size, created_by, created_at FROM article_images WHERE article_id = ?1 ORDER BY created_at").bind(articleId).all();
  const referenced = onlyReferencedImages
    ? new Set([row.cover_image_id, ...articleImageIdsFromMarkdown(row.content_md)].filter(Boolean))
    : null;
  return {
    ...parseArticleRow(row),
    images: (images.results || []).filter((image) => !referenced || referenced.has(image.id)).map(imageMeta),
  };
}

async function updateArticle(env, user, articleId, payload, { action = "update", detail = null, checkpoint = false, allowMissingTradeIds = [] } = {}) {
  const existing = await env.DB.prepare(`SELECT ${articleColumns} FROM articles WHERE id = ?1 AND deleted_at IS NULL`).bind(articleId).first();
  if (!existing) return { status: 404, error: "随笔不存在或已在回收站" };
  const cleaned = cleanArticlePayload({
    ...payload,
    summary: payload?.summary ?? existing.summary,
    slug: payload?.slug ?? existing.slug,
    visibility: payload?.visibility ?? existing.visibility,
    coverImageId: payload?.coverImageId === undefined ? existing.cover_image_id : payload.coverImageId,
  }, { requireRevision: true });
  if (Number(existing.revision) !== cleaned.revision) return { status: 409, error: "随笔已在其他页面更新，请刷新后再保存" };
  if (cleaned.visibility !== existing.visibility) return { status: 409, error: "请使用发布或撤回接口更改随笔可见性" };
  if (existing.published_revision !== null && existing.published_revision !== undefined && cleaned.slug !== (existing.slug || "")) {
    return { status: 409, error: "随笔首次发布后不能更改公开链接" };
  }
  await ensureSlugAvailable(env, articleId, cleaned.slug);
  await ensureCoverImageExists(env, articleId, cleaned.coverImageId);
  cleaned.tradeIds = await existingTradeIds(env, cleaned.tradeIds, {
    allowMissing: [...tradeIdsFromArticleMarkdown(existing.content_md), ...allowMissingTradeIds],
  });
  const nextRevision = cleaned.revision + 1;
  const now = new Date().toISOString();
  const updated = await env.DB.prepare("UPDATE articles SET title = ?1, summary = ?2, slug = ?3, content_md = ?4, excerpt = ?5, status = ?6, cover_image_id = ?7, tags_json = ?8, trade_ids_json = ?9, revision = ?10, updated_by = ?11, updated_at = ?12 WHERE id = ?13 AND revision = ?14 AND deleted_at IS NULL")
    .bind(cleaned.title, cleaned.summary, cleaned.slug || null, cleaned.contentMd, articleExcerpt(cleaned.contentMd), cleaned.status, cleaned.coverImageId, JSON.stringify(cleaned.tags), JSON.stringify(cleaned.tradeIds), nextRevision, user.login, now, articleId, cleaned.revision)
    .run();
  if (Number(updated.meta?.changes || 0) !== 1) return { status: 409, error: "随笔已在其他页面更新，请刷新后再保存" };
  await env.DB.batch([
    ...replaceWorkingArticleSearchStatements(env, articleId),
    ...(checkpoint ? [versionInsert(env, articleId, nextRevision, cleaned, user.login, now)] : []),
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
    const rawSearch = url.searchParams.get("q");
    const search = articleSearchQuery(rawSearch);
    const searchNeedle = articleSearchNeedle(rawSearch);
    const searchSql = search && !deleted ? ` AND id IN (
      SELECT article_id FROM article_working_fts WHERE article_working_fts MATCH ?1
      UNION
      SELECT article_id FROM article_working_fts
      WHERE lower(title) LIKE ?2 ESCAPE '\\'
         OR lower(summary) LIKE ?2 ESCAPE '\\'
         OR lower(content_md) LIKE ?2 ESCAPE '\\'
         OR lower(tags) LIKE ?2 ESCAPE '\\'
    )` : "";
    const statement = env.DB.prepare(`SELECT ${summaryColumns} FROM articles WHERE deleted_at IS ${deleted ? "NOT " : ""}NULL${searchSql} ORDER BY updated_at DESC`);
    const rows = searchSql ? await statement.bind(search, searchNeedle).all() : await statement.all();
    return json(request, env, { articles: (rows.results || []).map((row) => parseArticleRow(row, { includeContent: false })) });
  }

  if (path === "/api/articles" && request.method === "POST") {
    try {
      const cleaned = cleanArticlePayload(await request.json());
      cleaned.visibility = "private";
      cleaned.coverImageId = null;
      cleaned.tradeIds = await existingTradeIds(env, cleaned.tradeIds);
      const id = crypto.randomUUID();
      await ensureSlugAvailable(env, id, cleaned.slug);
      const now = new Date().toISOString();
      await env.DB.batch([
        env.DB.prepare("INSERT INTO articles (id, title, summary, slug, content_md, excerpt, status, visibility, cover_image_id, tags_json, trade_ids_json, revision, created_by, updated_by, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 'private', NULL, ?8, ?9, 1, ?10, ?10, ?11, ?11)")
          .bind(id, cleaned.title, cleaned.summary, cleaned.slug || null, cleaned.contentMd, articleExcerpt(cleaned.contentMd), cleaned.status, JSON.stringify(cleaned.tags), JSON.stringify(cleaned.tradeIds), user.login, now),
        ...replaceWorkingArticleSearchStatements(env, id),
        auditStatement(env, id, "create", user.login, now),
      ]);
      return json(request, env, { ok: true, article: await articleWithAssets(env, id) }, 201);
    } catch (error) { return json(request, env, { error: error.message || "新建随笔失败" }, 400); }
  }

  if (path === "/api/articles/export" && request.method === "GET") {
    if (user.role !== "editor") return json(request, env, { error: "当前账号无权导出完整随笔备份" }, 403);
    const rows = await env.DB.prepare(`SELECT ${articleColumns} FROM articles ORDER BY created_at`).all();
    const versions = await env.DB.prepare(`SELECT ${versionColumns} FROM article_versions ORDER BY article_id, revision`).all();
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

  const checkpointItem = path.match(new RegExp(`^/api/articles/${uuidPart}/checkpoints$`, "i"));
  if (checkpointItem && request.method === "POST") {
    try {
      const revision = requiredActionRevision(await request.json());
      const current = await env.DB.prepare(`SELECT ${articleColumns} FROM articles WHERE id = ?1 AND deleted_at IS NULL`).bind(checkpointItem[1]).first();
      if (!current) return json(request, env, { error: "随笔不存在或已在回收站" }, 404);
      if (Number(current.revision) !== revision) return json(request, env, { error: "随笔已在其他页面更新，请刷新后再建立检查点" }, 409);
      const now = new Date().toISOString();
      const article = parseArticleRow(current);
      const inserted = await versionInsert(env, article.id, revision, article, user.login, now, { conflict: "ignore" }).run();
      if (Number(inserted.meta?.changes || 0) === 1) {
        await auditStatement(env, article.id, "checkpoint", user.login, now, `revision:${revision}`).run();
      }
      const row = await env.DB.prepare(`SELECT ${versionColumns} FROM article_versions WHERE article_id = ?1 AND revision = ?2`).bind(article.id, revision).first();
      const version = row ? parseArticleVersionRow(row, { includeContent: true }) : null;
      return json(request, env, { ok: true, version, checkpoint: version, created: Number(inserted.meta?.changes || 0) === 1 });
    } catch (error) { return json(request, env, { error: error.message || "建立检查点失败" }, 400); }
  }

  const publishItem = path.match(new RegExp(`^/api/articles/${uuidPart}/publish$`, "i"));
  if (publishItem && request.method === "POST") {
    try {
      const revision = requiredActionRevision(await request.json());
      const current = await env.DB.prepare(`SELECT ${articleColumns} FROM articles WHERE id = ?1 AND deleted_at IS NULL`).bind(publishItem[1]).first();
      if (!current) return json(request, env, { error: "随笔不存在或已在回收站" }, 404);
      if (Number(current.revision) !== revision) return json(request, env, { error: "随笔已在其他页面更新，请刷新后再发布" }, 409);
      if (current.visibility === "public" && Number(current.published_revision) === revision) {
        return json(request, env, { ok: true, article: await articleWithAssets(env, publishItem[1]) });
      }
      const article = parseArticleRow(current);
      const slug = article.slug || autoPublishedSlug(article.id);
      await ensureSlugAvailable(env, article.id, slug);
      await ensurePublishedImagesExist(env, article.id, article.contentMd, article.coverImageId);
      await existingTradeIds(env, article.tradeIds);
      const now = new Date().toISOString();
      const updated = await env.DB.prepare("UPDATE articles SET slug = ?1, status = 'final', visibility = 'public', public_search_text = ?2, published_revision = ?3, published_at = COALESCE(published_at, ?4), updated_by = ?5, updated_at = ?4 WHERE id = ?6 AND revision = ?3 AND deleted_at IS NULL")
        .bind(slug, publicArticleSearchProjection(article), revision, now, user.login, article.id)
        .run();
      if (Number(updated.meta?.changes || 0) !== 1) return json(request, env, { error: "随笔已在其他页面更新，请刷新后再发布" }, 409);
      await auditStatement(env, article.id, "publish", user.login, now, `revision:${revision}`).run();
      return json(request, env, { ok: true, article: await articleWithAssets(env, article.id) });
    } catch (error) { return json(request, env, { error: error.message || "发布随笔失败" }, 400); }
  }

  const unpublishItem = path.match(new RegExp(`^/api/articles/${uuidPart}/unpublish$`, "i"));
  if (unpublishItem && request.method === "POST") {
    try {
      const revision = requiredActionRevision(await request.json());
      const current = await env.DB.prepare(`SELECT ${articleColumns} FROM articles WHERE id = ?1 AND deleted_at IS NULL`).bind(unpublishItem[1]).first();
      if (!current) return json(request, env, { error: "随笔不存在或已在回收站" }, 404);
      if (Number(current.revision) !== revision) return json(request, env, { error: "随笔已在其他页面更新，请刷新后再撤回" }, 409);
      if (current.visibility === "private") {
        return json(request, env, { ok: true, article: await articleWithAssets(env, unpublishItem[1]) });
      }
      const now = new Date().toISOString();
      const updated = await env.DB.prepare("UPDATE articles SET visibility = 'private', updated_by = ?1, updated_at = ?2 WHERE id = ?3 AND revision = ?4 AND deleted_at IS NULL")
        .bind(user.login, now, unpublishItem[1], revision)
        .run();
      if (Number(updated.meta?.changes || 0) !== 1) return json(request, env, { error: "随笔已在其他页面更新，请刷新后再撤回" }, 409);
      await env.DB.batch([
        removePublicArticleSearchStatement(env, unpublishItem[1]),
        auditStatement(env, unpublishItem[1], "unpublish", user.login, now, `revision:${revision}`),
      ]);
      return json(request, env, { ok: true, article: await articleWithAssets(env, unpublishItem[1]) });
    } catch (error) { return json(request, env, { error: error.message || "撤回随笔失败" }, 400); }
  }

  if (articleItem && request.method === "DELETE") {
    const now = new Date().toISOString();
    const result = await env.DB.prepare("UPDATE articles SET visibility = 'private', deleted_at = ?1, deleted_by = ?2, updated_at = ?1, updated_by = ?2 WHERE id = ?3 AND deleted_at IS NULL")
      .bind(now, user.login, articleItem[1]).run();
    if (!Number(result.meta?.changes || 0)) return json(request, env, { error: "随笔不存在或已在回收站" }, 404);
    await env.DB.batch([
      env.DB.prepare("DELETE FROM article_trade_links_derived WHERE article_id = ?1").bind(articleItem[1]),
      ...replaceWorkingArticleSearchStatements(env, articleItem[1]),
      removePublicArticleSearchStatement(env, articleItem[1]),
      auditStatement(env, articleItem[1], "delete", user.login, now),
    ]);
    return json(request, env, { ok: true, articleId: articleItem[1], deletedAt: now });
  }

  const restoreItem = path.match(new RegExp(`^/api/articles/${uuidPart}/restore$`, "i"));
  if (restoreItem && request.method === "POST") {
    const now = new Date().toISOString();
    const result = await env.DB.prepare("UPDATE articles SET deleted_at = NULL, deleted_by = NULL, updated_at = ?1, updated_by = ?2 WHERE id = ?3 AND deleted_at IS NOT NULL")
      .bind(now, user.login, restoreItem[1]).run();
    if (!Number(result.meta?.changes || 0)) return json(request, env, { error: "回收站中没有这篇随笔" }, 404);
    const restored = await articleWithAssets(env, restoreItem[1]);
    await env.DB.batch([
      ...replaceWorkingArticleSearchStatements(env, restoreItem[1]),
      removePublicArticleSearchStatement(env, restoreItem[1]),
      auditStatement(env, restoreItem[1], "restore", user.login, now),
    ]);
    return json(request, env, { ok: true, article: restored });
  }

  const versions = path.match(new RegExp(`^/api/articles/${uuidPart}/versions$`, "i"));
  if (versions && request.method === "GET") {
    if (user.role !== "editor") return json(request, env, { error: "当前账号无权查看随笔历史版本" }, 403);
    const rows = await env.DB.prepare(`SELECT ${versionColumns} FROM article_versions WHERE article_id = ?1 ORDER BY revision DESC`).bind(versions[1]).all();
    return json(request, env, { versions: (rows.results || []).map((row) => parseArticleVersionRow(row)) });
  }

  const versionItem = path.match(new RegExp(`^/api/articles/${uuidPart}/versions/(\\d+)$`, "i"));
  if (versionItem && request.method === "GET") {
    if (user.role !== "editor") return json(request, env, { error: "当前账号无权查看随笔历史版本" }, 403);
    const row = await env.DB.prepare(`SELECT ${versionColumns} FROM article_versions WHERE article_id = ?1 AND revision = ?2`).bind(versionItem[1], Number(versionItem[2])).first();
    return row ? json(request, env, { version: parseArticleVersionRow(row, { includeContent: true }) }) : json(request, env, { error: "历史版本不存在" }, 404);
  }

  const versionRestore = path.match(new RegExp(`^/api/articles/${uuidPart}/versions/(\\d+)/restore$`, "i"));
  if (versionRestore && request.method === "POST") {
    try {
      const expectedRevision = requiredActionRevision(await request.json());
      const current = await env.DB.prepare(`SELECT ${articleColumns} FROM articles WHERE id = ?1 AND deleted_at IS NULL`).bind(versionRestore[1]).first();
      const historical = await env.DB.prepare(`SELECT ${versionColumns} FROM article_versions WHERE article_id = ?1 AND revision = ?2`).bind(versionRestore[1], Number(versionRestore[2])).first();
      if (!current || !historical) return json(request, env, { error: "随笔或历史版本不存在" }, 404);
      if (Number(current.revision) !== expectedRevision) return json(request, env, { error: "随笔已在其他页面更新，请刷新后再恢复历史版本" }, 409);
      const old = parseArticleVersionRow(historical, { includeContent: true });
      const workingCopy = parseArticleRow(current);
      await versionInsert(env, workingCopy.id, workingCopy.revision, workingCopy, user.login, new Date().toISOString(), { conflict: "ignore" }).run();
      const result = await updateArticle(env, user, versionRestore[1], {
        ...old,
        slug: current.slug || "",
        visibility: current.visibility || "private",
        revision: expectedRevision,
      }, {
        action: "restore-version",
        detail: `revision:${old.revision}`,
        checkpoint: true,
        allowMissingTradeIds: tradeIdsFromArticleMarkdown(old.contentMd),
      });
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
      : "SELECT i.mime_type, i.byte_size, i.image_data, a.content_md, a.cover_image_id FROM article_images i JOIN articles a ON a.id = i.article_id WHERE i.id = ?1 AND a.deleted_at IS NULL";
    const row = await env.DB.prepare(sql).bind(imageItem[1]).first();
    const readOnlyReference = row && user.role !== "editor"
      ? row.cover_image_id === imageItem[1] || articleImageIdsFromMarkdown(row.content_md).includes(imageItem[1].toLowerCase())
      : true;
    if (!row || !readOnlyReference) return json(request, env, { error: "随笔图片不存在" }, 404);
    return new Response(new Uint8Array(row.image_data), { status: 200, headers: binaryHeaders(request, env, row.mime_type, row.byte_size) });
  }
  if (imageItem && request.method === "DELETE") {
    const row = await env.DB.prepare("SELECT article_id FROM article_images WHERE id = ?1").bind(imageItem[1]).first();
    if (!row) return json(request, env, { error: "随笔图片不存在" }, 404);
    const snapshots = await env.DB.prepare(`SELECT content_md, cover_image_id FROM articles WHERE id = ?1
      UNION ALL
      SELECT content_md, cover_image_id FROM article_versions WHERE article_id = ?1`).bind(row.article_id).all();
    const normalizedImageId = imageItem[1].toLowerCase();
    const referenced = (snapshots.results || []).some((snapshot) => String(snapshot.cover_image_id || "").toLowerCase() === normalizedImageId
      || articleImageIdsFromMarkdown(snapshot.content_md).includes(normalizedImageId));
    if (referenced) return json(request, env, { error: "图片仍被工作副本或历史检查点引用；为保证历史版本可恢复，暂不能删除" }, 409);
    const now = new Date().toISOString();
    await env.DB.batch([
      env.DB.prepare("DELETE FROM article_images WHERE id = ?1").bind(imageItem[1]),
      auditStatement(env, row.article_id, "image-delete", user.login, now, imageItem[1]),
    ]);
    return json(request, env, { ok: true, articleId: row.article_id });
  }

  const tradeArticles = path.match(/^\/api\/trades\/(TR-\d+)\/articles$/i);
  if (tradeArticles && request.method === "GET") {
    const rows = await env.DB.prepare(`SELECT ${qualifiedSummaryColumns} FROM articles a JOIN article_trade_links_derived l ON l.article_id = a.id WHERE l.trade_id = ?1 AND a.deleted_at IS NULL ORDER BY a.updated_at DESC`).bind(tradeArticles[1].toUpperCase()).all();
    return json(request, env, { articles: (rows.results || []).map((row) => parseArticleRow(row, { includeContent: false })) });
  }

  if (path.startsWith("/api/articles") || path.startsWith("/api/article-images")) return json(request, env, { error: "随笔接口不存在" }, 404);
  return null;
}
