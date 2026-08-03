const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function articleHash(articleId = "") {
  return articleId && uuidPattern.test(articleId) ? `#essay=${articleId}` : "#essays";
}

export function articleIdFromHash(hash = "") {
  const match = String(hash).match(/^#essay=([0-9a-f-]{36})$/i);
  return match && uuidPattern.test(match[1]) ? match[1] : "";
}

export function deriveImportedArticle(fileName, contentMd) {
  const content = String(contentMd ?? "");
  const heading = content.match(/^#\s+(.+?)\s*$/m)?.[1]?.trim();
  const fallback = String(fileName || "未命名随笔").replace(/\.md(?:own)?$/i, "").trim();
  return { title: (heading || fallback || "未命名随笔").slice(0, 120), contentMd: content };
}

export function filterArticleSummaries(rows, { query = "", tag = "", status = "", deleted = false } = {}) {
  const needle = String(query).trim().toLocaleLowerCase("zh-CN");
  return (rows || []).filter((article) => {
    if (Boolean(article.deletedAt) !== Boolean(deleted)) return false;
    if (status && article.status !== status) return false;
    if (tag && !(article.tags || []).includes(tag)) return false;
    if (!needle) return true;
    return [article.title, article.excerpt, ...(article.tags || [])]
      .join(" ")
      .toLocaleLowerCase("zh-CN")
      .includes(needle);
  });
}

export function articleDownloadName(title) {
  const safe = String(title || "未命名随笔").replace(/[\\/:*?"<>|\u0000-\u001f]/g, "_").trim();
  return `${safe || "未命名随笔"}.md`;
}
