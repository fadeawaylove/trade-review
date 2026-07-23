export const ATTACHMENT_CACHE_NAME = "trade-review-attachments-v1";

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
  if (cached) return cached.blob();

  if (pendingLoads.has(url)) return pendingLoads.get(url);
  const pending = (async () => {
    const response = await fetchImpl(url, { headers: { Authorization: `Bearer ${token}` } });
    if (!response.ok) {
      const error = new Error("图片读取失败");
      error.status = response.status;
      throw error;
    }
    const cacheCopy = response.clone();
    const blob = await response.blob();
    if (cache) await cache.put(url, cacheCopy).catch(() => {});
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
  try { return await cacheStorage.delete(ATTACHMENT_CACHE_NAME); }
  catch { return false; }
}
