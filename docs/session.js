const REFRESH_WINDOW_SECONDS = 3 * 24 * 60 * 60;
const ESSAY_HASH_PATTERN = /^#essay=[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function decodeClaims(token) {
  const payload = String(token || "").split(".")[1];
  if (!payload) return null;
  const normalized = payload.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized + "=".repeat((4 - normalized.length % 4) % 4);
  try {
    return JSON.parse(decodeURIComponent([...atob(padded)]
      .map((char) => `%${char.charCodeAt(0).toString(16).padStart(2, "0")}`)
      .join("")));
  } catch {
    return null;
  }
}

export function tokenNeedsRefresh(token, nowSeconds = Math.floor(Date.now() / 1000)) {
  const claims = decodeClaims(token);
  return !Number.isFinite(Number(claims?.exp))
    || Number(claims.exp) - nowSeconds <= REFRESH_WINDOW_SECONDS;
}

export function safeReturnHash(hash) {
  const value = String(hash || "");
  return value === "#essays" || ESSAY_HASH_PATTERN.test(value) ? value : "";
}
