export const MAX_ARTICLE_CONTENT_BYTES = 200 * 1024;
export const MAX_ARTICLE_IMAGE_BYTES = 1_700_000;
export const MAX_ARTICLE_IMAGES = 20;

const articleStatuses = new Set(["draft", "final"]);
const articleVisibilities = new Set(["private", "public"]);
const tradeIdPattern = /^TR-\d{4,}$/i;
const articleImageIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function openingFence(line) {
  const match = String(line || "").match(/^\s*(`{3,}|~{3,})(.*)$/);
  return match ? { character: match[1][0], length: match[1].length } : null;
}

function closesFence(line, fence) {
  const match = String(line || "").match(/^\s*(`{3,}|~{3,})\s*$/);
  return Boolean(match && match[1][0] === fence?.character && match[1].length >= fence.length);
}

export function markdownOutsideCodeAndComments(markdown) {
  const source = String(markdown || "").replace(/<!--[\s\S]*?-->/g, "");
  const visible = [];
  let fence = null;
  for (const line of source.replace(/\r\n?/g, "\n").split("\n")) {
    if (fence) {
      if (closesFence(line, fence)) fence = null;
      continue;
    }
    const opening = openingFence(line);
    if (opening) {
      fence = opening;
      continue;
    }
    visible.push(line.replace(/(`+)([^`\n]*?)\1/g, ""));
  }
  return visible.join("\n");
}

function footnoteKey(value) {
  return String(value || "").normalize("NFKC").toLocaleLowerCase();
}

function markdownForRenderedReferences(markdown) {
  const source = String(markdown || "").replace(/<!--[\s\S]*?-->/g, "").replace(/\r\n?/g, "\n");
  const definitions = new Map();
  const visible = [];
  const lines = source.split("\n");
  let fence = null;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (fence) {
      visible.push(line);
      if (closesFence(line, fence)) fence = null;
      continue;
    }
    const opening = openingFence(line);
    if (opening) {
      fence = opening;
      visible.push(line);
      continue;
    }
    const definition = line.match(/^\[\^([\p{L}\p{N}_-]+)\]:\s*(.*)$/u);
    if (!definition) {
      visible.push(line);
      continue;
    }
    const content = [definition[2]];
    while (index + 1 < lines.length) {
      const continuation = lines[index + 1].match(/^(?: {2,}|\t)(.*)$/);
      if (!continuation) break;
      content.push(continuation[1]);
      index += 1;
    }
    const key = footnoteKey(definition[1]);
    if (!definitions.has(key)) definitions.set(key, content.join(" ").trim());
  }
  const main = visible.join("\n");
  const queue = [...markdownOutsideCodeAndComments(main).matchAll(/\[\^([\p{L}\p{N}_-]+)\]/gu)].map((match) => footnoteKey(match[1]));
  const used = new Set();
  const referencedContent = [];
  while (queue.length) {
    const key = queue.shift();
    if (used.has(key) || !definitions.has(key)) continue;
    used.add(key);
    const content = definitions.get(key);
    referencedContent.push(content);
    for (const match of markdownOutsideCodeAndComments(content).matchAll(/\[\^([\p{L}\p{N}_-]+)\]/gu)) {
      queue.push(footnoteKey(match[1]));
    }
  }
  return [main, ...referencedContent].join("\n");
}

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
  return markdownOutsideCodeAndComments(contentMd)
    .replace(/<[^>]*>/g, " ")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, " ")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/[#>*_~`|\-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, limit);
}

export function tradeIdsFromArticleMarkdown(markdown) {
  const withoutCode = markdownOutsideCodeAndComments(markdownForRenderedReferences(markdown));
  const result = [];
  const seen = new Set();
  const tradeLinkPattern = /(?<!!)\[[^\]\n]*\]\(\s*trade:(TR-\d{4,})(?:\s+"[^"\n]*")?\s*\)/gi;
  for (const match of withoutCode.matchAll(tradeLinkPattern)) {
    const tradeId = match[1].toUpperCase();
    if (seen.has(tradeId)) continue;
    seen.add(tradeId);
    result.push(tradeId);
  }
  return result;
}

export function articleImageIdsFromMarkdown(markdown) {
  const withoutCode = markdownOutsideCodeAndComments(markdownForRenderedReferences(markdown));
  const result = [];
  const seen = new Set();
  const imagePattern = /!\[[^\]]*\]\(\s*article-image:([0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})(?:\s+"[^"]*")?\s*\)/gi;
  for (const match of withoutCode.matchAll(imagePattern)) {
    const imageId = match[1].toLowerCase();
    if (seen.has(imageId)) continue;
    seen.add(imageId);
    result.push(imageId);
  }
  return result;
}

export function publicArticleSearchText(markdown) {
  return markdownOutsideCodeAndComments(markdownForRenderedReferences(markdown))
    .replace(/!\[[^\]]*\]\([^)]*\)/g, " ")
    .replace(/!\[[^\]]*\]\[[^\]]*\]/g, " ")
    .replace(/\[[^\]]*\]\(\s*trade:TR-\d+[^)]*\)/gi, " 私密研究证据 ")
    .replace(/<\/?[A-Za-z][^>]*>/g, " ")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/^\s*\[[^\]]+\]:\s*\S+.*$/gm, " ")
    .replace(/https?:\/\/\S+/gi, " ")
    .replace(/article-image:[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/gi, " ")
    .replace(/TR-\d+/gi, " ")
    .replace(/[#>*_~|\\-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function publicArticleSearchProjection(article) {
  return publicArticleSearchText([
    article?.title,
    article?.summary,
    ...(Array.isArray(article?.tags) ? article.tags : []),
    article?.contentMd,
  ].filter(Boolean).join("\n"));
}

export function normalizeArticleSlug(value) {
  const slug = String(value ?? "")
    .normalize("NFKC")
    .trim()
    .toLocaleLowerCase("zh-CN")
    .replace(/[\s_]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
  if (!slug) return "";
  if (slug.length > 96) throw new Error("公开链接不能超过 96 个字符");
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug)) {
    throw new Error("公开链接只能包含小写英文字母、数字和连字符");
  }
  if (/tr-\d+/.test(slug)) throw new Error("公开链接不能包含交易编号");
  return slug;
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

  const summary = String(value?.summary ?? "").trim();
  if (summary.length > 320) throw new Error("随笔摘要不能超过 320 个字符");

  const slug = normalizeArticleSlug(value?.slug);
  const visibility = String(value?.visibility || "private");
  if (!articleVisibilities.has(visibility)) throw new Error("随笔可见性只能是 private 或 public");

  const coverImageId = String(value?.coverImageId ?? "").trim().toLowerCase() || null;
  if (coverImageId && !articleImageIdPattern.test(coverImageId)) throw new Error("随笔封面图片编号无效");

  const tags = uniqueTextList(value?.tags, { limit: 20, itemLimit: 24, label: "标签" });
  const tradeIds = uniqueTextList(tradeIdsFromArticleMarkdown(contentMd), {
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

  return { title, summary, slug, visibility, coverImageId, contentMd, status, tags, tradeIds, revision };
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
    summary: row.summary || "",
    slug: row.slug || "",
    visibility: row.visibility || "private",
    coverImageId: row.cover_image_id || null,
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
    publishedRevision: row.published_revision === null || row.published_revision === undefined ? null : Number(row.published_revision),
    publishedAt: row.published_at || null,
  };
  if (includeContent) article.contentMd = row.content_md || "";
  return article;
}

export function parseArticleVersionRow(row, { includeContent = false } = {}) {
  const version = {
    articleId: row.article_id,
    revision: Number(row.revision),
    title: row.title,
    summary: row.summary || "",
    slug: row.slug || "",
    coverImageId: row.cover_image_id || null,
    status: row.status,
    tags: parseJsonList(row.tags_json),
    tradeIds: parseJsonList(row.trade_ids_json),
    createdBy: row.created_by,
    createdAt: row.created_at,
  };
  if (includeContent) version.contentMd = row.content_md || "";
  return version;
}
