const tradeIdPattern = /^TR-\d{4,}$/i;
const privateImageIdPattern = "[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}";

function safeLabel(value) {
  return String(value || "").replace(/[\[\]()`\r\n]+/g, " ").replace(/\s+/g, " ").trim();
}

export function formatTradeReference(trade) {
  const tradeId = String(trade?.tradeId || "").trim().toUpperCase();
  if (!tradeIdPattern.test(tradeId)) return "";
  const instrument = safeLabel(trade?.instrument);
  const label = `交易 ${tradeId}${instrument ? ` · ${instrument}` : ""}`;
  return `[${label}](trade:${tradeId})`;
}

function tradeSequence(tradeId) {
  const match = String(tradeId || "").match(/^TR-(\d+)$/i);
  return match ? Number(match[1]) : -1;
}

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

export function tradePickerTrades(dashboard) {
  return [...(dashboard?.trades || [])]
    .filter((trade) => trade && !trade.deletedAt)
    .sort((a, b) => {
      const dateOrder = String(b.date || b.dateLabel || "").localeCompare(String(a.date || a.dateLabel || ""));
      if (dateOrder) return dateOrder;
      const sequenceOrder = tradeSequence(b.tradeId) - tradeSequence(a.tradeId);
      return sequenceOrder || String(b.tradeId || "").localeCompare(String(a.tradeId || ""));
    });
}

export function tradeIdsFromMarkdown(markdown) {
  const withoutCode = markdownOutsideCodeAndComments(markdown);
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

export function privateArticleImageIds(markdown) {
  const result = [];
  const seen = new Set();
  const pattern = new RegExp(`!\\[[^\\]]*\\]\\(\\s*article-image:(${privateImageIdPattern})(?=(?:\\s+"[^"\\n]*")?\\s*\\))`, "gi");
  for (const match of markdownOutsideCodeAndComments(markdown).matchAll(pattern)) {
    const imageId = match[1].toLowerCase();
    if (seen.has(imageId)) continue;
    seen.add(imageId);
    result.push(imageId);
  }
  return result;
}

export function replacePrivateArticleImages(markdown, sourcesById) {
  const pattern = new RegExp(`(!\\[[^\\]]*\\]\\(\\s*)article-image:(${privateImageIdPattern})(?=(?:\\s+"[^"\\n]*")?\\s*\\))`, "gi");
  return String(markdown || "").replace(pattern, (reference, prefix, imageId) => {
    const localUrl = sourcesById?.get(String(imageId).toLowerCase());
    return localUrl ? `${prefix}${localUrl}` : reference;
  });
}

export function restorePrivateArticleImages(markdown, sourcesById) {
  let restored = String(markdown || "");
  for (const [imageId, localUrl] of sourcesById || []) {
    if (!localUrl) continue;
    restored = restored.split(localUrl).join(`article-image:${imageId}`);
  }
  return restored;
}
