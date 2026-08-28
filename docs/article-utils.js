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

export function preserveUnchangedMarkdown(storedMarkdown, editorBaseline, editorMarkdown) {
  const current = String(editorMarkdown ?? "");
  return current === String(editorBaseline ?? "") ? String(storedMarkdown ?? "") : current;
}

export function articlePublicationProgress(article) {
  const publishedRevision = Number(article?.publishedRevision) || 0;
  const revision = Number(article?.revision) || 0;
  if (article?.status === "final" && !publishedRevision) return "pending-first";
  if (publishedRevision && revision > publishedRevision) return "pending-update";
  return "";
}

export function needsArticlePublishing(article) {
  return Boolean(articlePublicationProgress(article));
}

function markdownLines(value) {
  const normalized = String(value ?? "").replace(/\r\n?/g, "\n");
  return normalized ? normalized.split("\n") : [];
}

function withLineNumbers(operations) {
  let beforeLine = 1;
  let afterLine = 1;
  return operations.map((operation) => {
    const numbered = {
      ...operation,
      beforeLine: operation.type === "insert" ? null : beforeLine,
      afterLine: operation.type === "delete" ? null : afterLine,
    };
    if (operation.type !== "insert") beforeLine += 1;
    if (operation.type !== "delete") afterLine += 1;
    return numbered;
  });
}

function backtrackLineDiff(trace, before, after) {
  let x = before.length;
  let y = after.length;
  const operations = [];

  for (let distance = trace.length - 1; distance >= 0; distance -= 1) {
    const frontier = trace[distance];
    const diagonal = x - y;
    const previousDiagonal = diagonal === -distance
      || (diagonal !== distance && (frontier.get(diagonal - 1) ?? -1) < (frontier.get(diagonal + 1) ?? -1))
      ? diagonal + 1
      : diagonal - 1;
    const previousX = frontier.get(previousDiagonal) ?? 0;
    const previousY = previousX - previousDiagonal;

    while (x > previousX && y > previousY) {
      operations.push({ type: "equal", text: before[x - 1] });
      x -= 1;
      y -= 1;
    }
    if (distance === 0) break;
    if (x === previousX) {
      operations.push({ type: "insert", text: after[y - 1] });
      y -= 1;
    } else {
      operations.push({ type: "delete", text: before[x - 1] });
      x -= 1;
    }
  }

  return withLineNumbers(operations.reverse());
}

export function buildArticleLineDiff(checkpointMarkdown, currentMarkdown) {
  const before = markdownLines(checkpointMarkdown);
  const after = markdownLines(currentMarkdown);
  const maximumDistance = before.length + after.length;
  const frontier = new Map([[1, 0]]);
  const trace = [];

  for (let distance = 0; distance <= maximumDistance; distance += 1) {
    trace.push(new Map(frontier));
    for (let diagonal = -distance; diagonal <= distance; diagonal += 2) {
      let x;
      if (diagonal === -distance
        || (diagonal !== distance && (frontier.get(diagonal - 1) ?? -1) < (frontier.get(diagonal + 1) ?? -1))) {
        x = frontier.get(diagonal + 1) ?? 0;
      } else {
        x = (frontier.get(diagonal - 1) ?? 0) + 1;
      }
      let y = x - diagonal;
      while (x < before.length && y < after.length && before[x] === after[y]) {
        x += 1;
        y += 1;
      }
      frontier.set(diagonal, x);
      if (x >= before.length && y >= after.length) return backtrackLineDiff(trace, before, after);
    }
  }

  return [];
}

export function filterArticleSummaries(rows, { query = "", tag = "", status = "", deleted = false } = {}) {
  const needle = String(query).trim().toLocaleLowerCase("zh-CN");
  return (rows || []).filter((article) => {
    if (Boolean(article.deletedAt) !== Boolean(deleted)) return false;
    if (status && article.status !== status) return false;
    if (tag && !(article.tags || []).includes(tag)) return false;
    if (!needle) return true;
    return [article.title, article.summary, article.excerpt, ...(article.tags || [])]
      .join(" ")
      .toLocaleLowerCase("zh-CN")
      .includes(needle);
  });
}

export function articleDownloadName(title) {
  const safe = String(title || "未命名随笔").replace(/[\\/:*?"<>|\u0000-\u001f]/g, "_").trim();
  return `${safe || "未命名随笔"}.md`;
}

export function proportionalScrollTop(source, target) {
  const sourceRange = Math.max(0, Number(source?.scrollHeight || 0) - Number(source?.clientHeight || 0));
  const targetRange = Math.max(0, Number(target?.scrollHeight || 0) - Number(target?.clientHeight || 0));
  if (!sourceRange || !targetRange) return 0;
  const ratio = Math.min(1, Math.max(0, Number(source?.scrollTop || 0) / sourceRange));
  return Math.round(targetRange * ratio);
}
