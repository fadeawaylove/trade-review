export const MAX_ARTICLE_CONTENT_BYTES = 200 * 1024;
export const MAX_ARTICLE_IMAGE_BYTES = 1_700_000;
export const MAX_ARTICLE_IMAGES = 20;

const articleStatuses = new Set(["draft", "final"]);
const tradeIdPattern = /^TR-\d{4,}$/i;

function uniqueTextList(values, { limit, itemLimit, label, normalize = (value) => value } = {}) {
  if (!Array.isArray(values)) return [];
  const result = [];
  const seen = new Set();
  for (const raw of values) {
    const value = normalize(String(raw ?? "").trim());
    if (!value) continue;
    if (value.length > itemLimit) throw new Error(`${label}单项不能超过 ${itemLimit} 个字符`);
    const key = value.toLocaleLowerCase("zh-CN");
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(value);
    if (result.length > limit) throw new Error(`${label}最多 ${limit} 项`);
  }
  return result;
}

export function articleExcerpt(contentMd, limit = 180) {
  return String(contentMd || "")
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/<[^>]*>/g, " ")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, " ")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/[#>*_~`|\-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, limit);
}

export function cleanArticlePayload(value, { requireRevision = false } = {}) {
  const title = String(value?.title ?? "").trim();
  if (!title) throw new Error("随笔标题不能为空");
  if (title.length > 120) throw new Error("随笔标题不能超过 120 个字符");

  const contentMd = String(value?.contentMd ?? "");
  if (new TextEncoder().encode(contentMd).byteLength > MAX_ARTICLE_CONTENT_BYTES) {
    throw new Error("随笔正文不能超过 200 KB");
  }

  const status = String(value?.status || "draft");
  if (!articleStatuses.has(status)) throw new Error("随笔状态只能是 draft 或 final");

  const tags = uniqueTextList(value?.tags, { limit: 10, itemLimit: 24, label: "标签" });
  const tradeIds = uniqueTextList(value?.tradeIds, {
    limit: 50,
    itemLimit: 20,
    label: "关联交易",
    normalize: (item) => item.toUpperCase(),
  });
  if (tradeIds.some((tradeId) => !tradeIdPattern.test(tradeId))) throw new Error("关联交易编号格式无效");

  let revision = null;
  if (value?.revision !== undefined && value?.revision !== null && value?.revision !== "") {
    revision = Number(value.revision);
    if (!Number.isInteger(revision) || revision < 1) throw new Error("随笔版本号无效");
  } else if (requireRevision) {
    throw new Error("保存随笔时必须提供版本号");
  }

  return { title, contentMd, status, tags, tradeIds, revision };
}

function parseJsonList(value) {
  try {
    const parsed = JSON.parse(value || "[]");
    return Array.isArray(parsed) ? parsed : [];
  } catch { return []; }
}

export function parseArticleRow(row, { includeContent = true } = {}) {
  const article = {
    id: row.id,
    title: row.title,
    excerpt: row.excerpt || "",
    status: row.status,
    tags: parseJsonList(row.tags_json),
    tradeIds: parseJsonList(row.trade_ids_json),
    revision: Number(row.revision || 1),
    createdBy: row.created_by,
    updatedBy: row.updated_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    deletedAt: row.deleted_at || null,
  };
  if (includeContent) article.contentMd = row.content_md || "";
  return article;
}

export function parseArticleVersionRow(row, { includeContent = false } = {}) {
  const version = {
    articleId: row.article_id,
    revision: Number(row.revision),
    title: row.title,
    status: row.status,
    tags: parseJsonList(row.tags_json),
    tradeIds: parseJsonList(row.trade_ids_json),
    createdBy: row.created_by,
    createdAt: row.created_at,
  };
  if (includeContent) version.contentMd = row.content_md || "";
  return version;
}
