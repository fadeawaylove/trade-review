export const ATTACHMENT_CACHE_NAME = "trade-review-attachments-v2";
export const ATTACHMENT_CACHE_TTL_MS = 365 * 24 * 60 * 60 * 1000;

const LEGACY_ATTACHMENT_CACHE_NAMES = ["trade-review-attachments-v1"];

const pendingLoads = new Map();

export function attachmentUrl(apiBase, attachmentId) {
  return `${String(apiBase || "").replace(/\/$/, "")}/api/attachments/${encodeURIComponent(attachmentId)}`;
}

async function openAttachmentCache(cacheStorage) {
  if (!cacheStorage?.open) return null;
  try { return await cacheStorage.open(ATTACHMENT_CACHE_NAME); }
  catch { return null; }
}

export async function loadAttachmentBlob({ apiBase, attachmentId, token, fetchImpl = globalThis.fetch, cacheStorage = globalThis.caches }) {
  const url = attachmentUrl(apiBase, attachmentId);
  const cache = await openAttachmentCache(cacheStorage);
  const cached = await cache?.match(url).catch(() => null);
  if (cached) {
    const cachedAt = Number(cached.headers.get("X-Trade-Cache-At") || 0);
    if (cachedAt && Date.now() - cachedAt <= ATTACHMENT_CACHE_TTL_MS) return cached.blob();
    await cache?.delete(url).catch(() => {});
  }

  if (pendingLoads.has(url)) return pendingLoads.get(url);
  const pending = (async () => {
    const response = await fetchImpl(url, { headers: { Authorization: `Bearer ${token}` } });
    if (!response.ok) {
      const error = new Error("图片读取失败");
      error.status = response.status;
      throw error;
    }
    const blob = await response.blob();
    if (cache) {
      const headers = new Headers(response.headers);
      headers.set("X-Trade-Cache-At", String(Date.now()));
      await cache.put(url, new Response(blob, { status: 200, headers })).catch(() => {});
    }
    return blob;
  })();
  pendingLoads.set(url, pending);
  try { return await pending; }
  finally { pendingLoads.delete(url); }
}

export async function removeAttachmentFromCache(apiBase, attachmentId, cacheStorage = globalThis.caches) {
  const cache = await openAttachmentCache(cacheStorage);
  if (!cache) return false;
  try { return await cache.delete(attachmentUrl(apiBase, attachmentId)); }
  catch { return false; }
}

export async function clearAttachmentCache(cacheStorage = globalThis.caches) {
  if (!cacheStorage?.delete) return false;
  try {
    const results = await Promise.all([ATTACHMENT_CACHE_NAME, ...LEGACY_ATTACHMENT_CACHE_NAMES].map((name) => cacheStorage.delete(name)));
    return results.some(Boolean);
  }
  catch { return false; }
}
