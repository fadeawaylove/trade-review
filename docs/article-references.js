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

export function tradeIdsFromMarkdown(markdown) {
  const withoutCode = String(markdown || "")
    .replace(/```[\s\S]*?```/g, "")
    .replace(/`[^`\n]*`/g, "");
  const result = [];
  const seen = new Set();
  for (const match of withoutCode.matchAll(/\]\(trade:(TR-\d{4,})\)/gi)) {
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
  const pattern = new RegExp(`!\\[[^\\]]*\\]\\(article-image:(${privateImageIdPattern})\\)`, "gi");
  for (const match of String(markdown || "").matchAll(pattern)) {
    const imageId = match[1].toLowerCase();
    if (seen.has(imageId)) continue;
    seen.add(imageId);
    result.push(imageId);
  }
  return result;
}

export function replacePrivateArticleImages(markdown, sourcesById) {
  const pattern = new RegExp(`(!\\[[^\\]]*\\]\\()article-image:(${privateImageIdPattern})(\\))`, "gi");
  return String(markdown || "").replace(pattern, (reference, prefix, imageId, suffix) => {
    const localUrl = sourcesById?.get(String(imageId).toLowerCase());
    return localUrl ? `${prefix}${localUrl}${suffix}` : reference;
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
