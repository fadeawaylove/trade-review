import { githubAccessRole, isAllowedGithubLogin } from "./access.js";

const encoder = new TextEncoder();
const SESSION_TTL_SECONDS = 60 * 60 * 24 * 30;
const MAX_ATTACHMENT_BYTES = 1_700_000;
const MAX_ATTACHMENTS_PER_TRADE = 5;
const ALLOWED_IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/webp"]);
const allowedOverrideFields = new Set([
  "date", "plannedRisk", "actualRisk", "setup", "marketEnvironment", "executionScore",
  "violationTag", "entryReason", "exitReason", "emotion", "reviewNotes",
]);

function base64url(input) {
  const bytes = typeof input === "string" ? encoder.encode(input) : input;
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function decode64url(value) {
  const padded = value.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((value.length + 3) % 4);
  const binary = atob(padded);
  return new Uint8Array([...binary].map((char) => char.charCodeAt(0)));
}

async function hmac(value, secret) {
  const key = await crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return base64url(new Uint8Array(await crypto.subtle.sign("HMAC", key, encoder.encode(value))));
}

function equalSafe(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let index = 0; index < a.length; index += 1) diff |= a.charCodeAt(index) ^ b.charCodeAt(index);
  return diff === 0;
}

async function signState(payload, secret) {
  const body = base64url(JSON.stringify(payload));
  return `${body}.${await hmac(body, secret)}`;
}

async function verifyState(state, secret) {
  const [body, signature] = String(state || "").split(".");
  if (!body || !signature || !equalSafe(signature, await hmac(body, secret))) throw new Error("登录状态校验失败");
  const payload = JSON.parse(new TextDecoder().decode(decode64url(body)));
  if (!payload.exp || payload.exp < Math.floor(Date.now() / 1000)) throw new Error("登录请求已过期");
  return payload;
}

async function issueToken(user, secret) {
  const header = base64url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const payload = base64url(JSON.stringify({
    sub: String(user.id || user.sub), login: user.login, name: user.name || user.login, avatar: user.avatar_url || user.avatar || "",
    iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + SESSION_TTL_SECONDS,
  }));
  const value = `${header}.${payload}`;
  return `${value}.${await hmac(value, secret)}`;
}

async function verifyToken(request, env) {
  const token = (request.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "");
  const [header, payload, signature] = token.split(".");
  if (!header || !payload || !signature) return null;
  const value = `${header}.${payload}`;
  if (!equalSafe(signature, await hmac(value, env.JWT_SECRET))) return null;
  try {
    const claims = JSON.parse(new TextDecoder().decode(decode64url(payload)));
    const role = githubAccessRole(claims.login, env);
    if (claims.exp < Math.floor(Date.now() / 1000) || !role) return null;
    return { ...claims, role };
  } catch { return null; }
}

function corsHeaders(request, env) {
  const origin = request.headers.get("Origin");
  return origin === env.ALLOWED_ORIGIN ? {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Headers": "Authorization, Content-Type, X-File-Name",
    "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
    "Access-Control-Max-Age": "86400",
    Vary: "Origin",
  } : {};
}

function attachmentHeaders(request, env, mimeType, byteSize) {
  return {
    "Content-Type": mimeType,
    "Content-Length": String(byteSize),
    "Cache-Control": "private, max-age=31536000, immutable",
    "X-Content-Type-Options": "nosniff",
    ...corsHeaders(request, env),
  };
}

function cleanFileName(value) {
  return decodeURIComponent(String(value || "复盘图")).replace(/[\\/:*?"<>|\u0000-\u001f]/g, "_").trim().slice(0, 120) || "复盘图";
}

const attachmentMeta = (row) => ({
  id: row.id,
  tradeId: row.trade_id,
  fileName: row.file_name,
  mimeType: row.mime_type,
  byteSize: row.byte_size,
  createdAt: row.created_at,
});

function json(request, env, payload, status = 200, extra = {}) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
      ...corsHeaders(request, env),
      ...extra,
    },
  });
}

function cleanOverride(value) {
  const result = {};
  for (const [key, raw] of Object.entries(value || {})) {
    if (!allowedOverrideFields.has(key)) continue;
    if (["plannedRisk", "actualRisk"].includes(key)) {
      if (raw === "" || raw === null || raw === undefined) continue;
      const number = Number(raw);
      if (!Number.isFinite(number) || number < 0) throw new Error(`${key} 必须是大于或等于 0 的数字`);
      result[key] = number;
    } else if (key === "executionScore") {
      if (raw === "" || raw === null || raw === undefined) continue;
      const number = Number(raw);
      if (!Number.isInteger(number) || number < 1 || number > 5) throw new Error("执行评分必须是 1 到 5 的整数");
      result[key] = number;
    } else if (key === "date") {
      if (!raw) continue;
      if (!/^\d{4}-\d{2}-\d{2}$/.test(String(raw))) throw new Error("日期格式必须为 YYYY-MM-DD");
      result[key] = String(raw);
    } else {
      const text = String(raw ?? "").trim();
      if (text) result[key] = text.slice(0, 4000);
    }
  }
  return result;
}

async function loadDashboard(env) {
  const datasetRow = await env.DB.prepare("SELECT payload, updated_at FROM dataset WHERE id = 1").first();
  if (!datasetRow) return null;
  const data = JSON.parse(datasetRow.payload);
  const overrideRows = await env.DB.prepare("SELECT trade_id, payload, updated_at FROM overrides").all();
  const overrides = Object.fromEntries((overrideRows.results || []).map((row) => [row.trade_id, JSON.parse(row.payload)]));
  const attachmentRows = await env.DB.prepare("SELECT id, trade_id, file_name, mime_type, byte_size, created_at FROM trade_attachments ORDER BY created_at").all();
  const deletedRows = await env.DB.prepare("SELECT trade_id, deleted_at FROM deleted_trades ORDER BY deleted_at DESC").all();
  const latestAudit = await env.DB.prepare("SELECT created_at FROM audit_log ORDER BY created_at DESC LIMIT 1").first();
  const deletedById = new Map((deletedRows.results || []).map((row) => [row.trade_id, row.deleted_at]));
  const attachments = new Map();
  for (const row of attachmentRows.results || []) {
    const rows = attachments.get(row.trade_id) || [];
    rows.push(attachmentMeta(row));
    attachments.set(row.trade_id, rows);
  }
  let latest = datasetRow.updated_at;
  for (const row of overrideRows.results || []) if (row.updated_at > latest) latest = row.updated_at;
  for (const row of attachmentRows.results || []) if (row.created_at > latest) latest = row.created_at;
  for (const row of deletedRows.results || []) if (row.deleted_at > latest) latest = row.deleted_at;
  if (latestAudit?.created_at > latest) latest = latestAudit.created_at;
  const allTrades = (data.trades || []).map((base) => {
    const override = overrides[base.tradeId] || {};
    const trade = { ...base, ...override };
    if (override.date) {
      trade.date = override.date;
      trade.dateLabel = override.date;
      trade.dateStatus = "已确认";
    }
    trade.plannedR = Number(trade.plannedRisk) > 0 ? Math.round((trade.netPnl / Number(trade.plannedRisk)) * 100) / 100 : null;
    trade.actualR = Number(trade.actualRisk) > 0 ? Math.round((trade.netPnl / Number(trade.actualRisk)) * 100) / 100 : null;
    // Keep the original field for older clients and exported datasets.
    trade.rMultiple = trade.plannedR;
    trade.attachments = attachments.get(base.tradeId) || [];
    return trade;
  });
  const trades = allTrades.filter((trade) => !deletedById.has(trade.tradeId));
  const deletedTrades = allTrades
    .filter((trade) => deletedById.has(trade.tradeId))
    .map((trade) => ({ ...trade, deletedAt: deletedById.get(trade.tradeId) }))
    .sort((a, b) => String(b.deletedAt).localeCompare(String(a.deletedAt)));
  return { ...data, meta: { ...(data.meta || {}), cloudUpdatedAt: latest }, trades, deletedTrades };
}

async function handleOAuthLogin(request, env) {
  const url = new URL(request.url);
  const returnUrl = url.searchParams.get("return") || env.PAGES_URL;
  if (!returnUrl.startsWith(env.PAGES_URL)) return new Response("Invalid return URL", { status: 400 });
  const state = await signState({ returnUrl, exp: Math.floor(Date.now() / 1000) + 600, nonce: crypto.randomUUID() }, env.JWT_SECRET);
  const authorize = new URL("https://github.com/login/oauth/authorize");
  authorize.searchParams.set("client_id", env.GITHUB_CLIENT_ID);
  authorize.searchParams.set("redirect_uri", `${url.origin}/auth/callback`);
  authorize.searchParams.set("scope", "read:user");
  authorize.searchParams.set("state", state);
  return Response.redirect(authorize.toString(), 302);
}

async function handleOAuthCallback(request, env) {
  const url = new URL(request.url);
  try {
    const state = await verifyState(url.searchParams.get("state"), env.JWT_SECRET);
    const now = Math.floor(Date.now() / 1000);
    const code = url.searchParams.get("code") || "";
    const codeHash = await hmac(code, env.JWT_SECRET);
    const receipt = await env.DB.prepare(
      "SELECT token, return_url FROM oauth_receipts WHERE nonce = ? AND code_hash = ? AND expires_at >= ?"
    ).bind(state.nonce, codeHash, now).first();
    if (receipt?.token) {
      return Response.redirect(`${receipt.return_url}#token=${encodeURIComponent(receipt.token)}`, 302);
    }

    const tokenResponse = await fetch("https://github.com/login/oauth/access_token", {
      method: "POST",
      headers: { Accept: "application/json", "Content-Type": "application/json", "User-Agent": "trade-review-cloud" },
      body: JSON.stringify({ client_id: env.GITHUB_CLIENT_ID, client_secret: env.GITHUB_CLIENT_SECRET, code, redirect_uri: `${url.origin}/auth/callback` }),
    });
    const tokenData = await tokenResponse.json();
    if (!tokenData.access_token) {
      if (tokenData.error === "bad_verification_code") {
        const retry = new URL("/auth/login", url.origin);
        retry.searchParams.set("return", state.returnUrl);
        return Response.redirect(retry.toString(), 302);
      }
      throw new Error(tokenData.error_description || "GitHub 授权失败，请重新登录");
    }
    const userResponse = await fetch("https://api.github.com/user", {
      headers: { Authorization: `Bearer ${tokenData.access_token}`, Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28", "User-Agent": "trade-review-cloud" },
    });
    const user = await userResponse.json();
    if (!isAllowedGithubLogin(user.login, env)) return new Response("此 GitHub 账号无权访问交易数据。", { status: 403 });
    const token = await issueToken(user, env.JWT_SECRET);
    await env.DB.batch([
      env.DB.prepare(
        "INSERT OR REPLACE INTO oauth_receipts (nonce, code_hash, token, return_url, expires_at) VALUES (?, ?, ?, ?, ?)"
      ).bind(state.nonce, codeHash, token, state.returnUrl, state.exp),
      env.DB.prepare("DELETE FROM oauth_receipts WHERE expires_at < ?").bind(now),
    ]);
    return Response.redirect(`${state.returnUrl}#token=${encodeURIComponent(token)}`, 302);
  } catch (error) {
    return new Response(`登录失败：${error.message}`, { status: 400, headers: { "Content-Type": "text/plain; charset=utf-8" } });
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders(request, env) });
    if (url.pathname === "/auth/login" && request.method === "GET") return handleOAuthLogin(request, env);
    if (url.pathname === "/auth/callback" && request.method === "GET") return handleOAuthCallback(request, env);
    if (url.pathname === "/api/health" && request.method === "GET") return json(request, env, { ok: true, storage: "cloudflare-d1" });

    const user = await verifyToken(request, env);
    if (!user) return json(request, env, { error: "请使用 GitHub 登录" }, 401);
    if (url.pathname === "/api/session" && request.method === "GET") return json(request, env, { user: { login: user.login, name: user.name, avatar: user.avatar, role: user.role } });
    if (url.pathname === "/api/session/refresh" && request.method === "POST") {
      const token = await issueToken(user, env.JWT_SECRET);
      return json(request, env, { token, expiresAt: new Date((Math.floor(Date.now() / 1000) + SESSION_TTL_SECONDS) * 1000).toISOString() });
    }
    if (user.role !== "editor" && !["GET", "HEAD"].includes(request.method)) {
      return json(request, env, { error: "当前账号仅有浏览权限" }, 403);
    }
    if (url.pathname === "/api/dashboard" && request.method === "GET") {
      const dashboard = await loadDashboard(env);
      return dashboard ? json(request, env, dashboard) : json(request, env, { error: "云端底稿尚未初始化" }, 503);
    }
    if (url.pathname === "/api/export" && request.method === "GET") {
      const dashboard = await loadDashboard(env);
      return json(request, env, dashboard || {}, 200, { "Content-Disposition": "attachment; filename=trade-review-cloud-export.json" });
    }

    const attachmentCollection = url.pathname.match(/^\/api\/trades\/(TR-\d+)\/attachments$/);
    if (attachmentCollection && request.method === "POST") {
      try {
        const tradeId = attachmentCollection[1];
        const dashboard = await loadDashboard(env);
        if (!dashboard?.trades?.some((trade) => trade.tradeId === tradeId)) return json(request, env, { error: "交易编号不存在" }, 404);
        const mimeType = (request.headers.get("Content-Type") || "").split(";")[0].toLowerCase();
        if (!ALLOWED_IMAGE_TYPES.has(mimeType)) return json(request, env, { error: "仅支持 PNG、JPEG 或 WebP 图片" }, 415);
        const current = await env.DB.prepare("SELECT COUNT(*) AS count FROM trade_attachments WHERE trade_id = ?1").bind(tradeId).first();
        if (Number(current?.count || 0) >= MAX_ATTACHMENTS_PER_TRADE) return json(request, env, { error: `每笔交易最多保存 ${MAX_ATTACHMENTS_PER_TRADE} 张复盘图` }, 409);
        const bytes = await request.arrayBuffer();
        if (!bytes.byteLength) return json(request, env, { error: "图片内容为空" }, 400);
        if (bytes.byteLength > MAX_ATTACHMENT_BYTES) return json(request, env, { error: "图片超过 1.7 MB，请压缩后重试" }, 413);
        const id = crypto.randomUUID();
        const now = new Date().toISOString();
        const fileName = cleanFileName(request.headers.get("X-File-Name"));
        await env.DB.batch([
          env.DB.prepare("INSERT INTO trade_attachments (id, trade_id, file_name, mime_type, byte_size, image_data, created_by, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)")
            .bind(id, tradeId, fileName, mimeType, bytes.byteLength, bytes, user.login, now),
          env.DB.prepare("INSERT INTO audit_log (trade_id, action, actor, created_at) VALUES (?1, ?2, ?3, ?4)").bind(tradeId, "attachment-upload", user.login, now),
        ]);
        return json(request, env, { ok: true, attachment: attachmentMeta({ id, trade_id: tradeId, file_name: fileName, mime_type: mimeType, byte_size: bytes.byteLength, created_at: now }) }, 201);
      } catch (error) { return json(request, env, { error: error.message || "图片上传失败" }, 400); }
    }

    const attachmentItem = url.pathname.match(/^\/api\/attachments\/([0-9a-f-]{36})$/i);
    if (attachmentItem && request.method === "GET") {
      const row = await env.DB.prepare("SELECT mime_type, byte_size, image_data FROM trade_attachments WHERE id = ?1").bind(attachmentItem[1]).first();
      if (!row) return json(request, env, { error: "复盘图不存在" }, 404);
      return new Response(new Uint8Array(row.image_data), { status: 200, headers: attachmentHeaders(request, env, row.mime_type, row.byte_size) });
    }
    if (attachmentItem && request.method === "DELETE") {
      const row = await env.DB.prepare("SELECT trade_id FROM trade_attachments WHERE id = ?1").bind(attachmentItem[1]).first();
      if (!row) return json(request, env, { error: "复盘图不存在" }, 404);
      const now = new Date().toISOString();
      await env.DB.batch([
        env.DB.prepare("DELETE FROM trade_attachments WHERE id = ?1").bind(attachmentItem[1]),
        env.DB.prepare("INSERT INTO audit_log (trade_id, action, actor, created_at) VALUES (?1, ?2, ?3, ?4)").bind(row.trade_id, "attachment-delete", user.login, now),
      ]);
      return json(request, env, { ok: true, tradeId: row.trade_id, updatedAt: now });
    }

    const deleteRecord = url.pathname.match(/^\/api\/trades\/(TR-\d+)\/record$/);
    if (deleteRecord && request.method === "DELETE") {
      const dashboard = await loadDashboard(env);
      if (!dashboard?.trades?.some((trade) => trade.tradeId === deleteRecord[1])) return json(request, env, { error: "交易编号不存在或已在回收站" }, 404);
      const now = new Date().toISOString();
      await env.DB.batch([
        env.DB.prepare("INSERT INTO deleted_trades (trade_id, deleted_by, deleted_at) VALUES (?1, ?2, ?3) ON CONFLICT(trade_id) DO UPDATE SET deleted_by = excluded.deleted_by, deleted_at = excluded.deleted_at").bind(deleteRecord[1], user.login, now),
        env.DB.prepare("INSERT INTO audit_log (trade_id, action, actor, created_at) VALUES (?1, ?2, ?3, ?4)").bind(deleteRecord[1], "trade-delete", user.login, now),
      ]);
      return json(request, env, { ok: true, tradeId: deleteRecord[1], deletedAt: now });
    }

    const restoreRecord = url.pathname.match(/^\/api\/trades\/(TR-\d+)\/restore$/);
    if (restoreRecord && request.method === "POST") {
      const dashboard = await loadDashboard(env);
      if (!dashboard?.deletedTrades?.some((trade) => trade.tradeId === restoreRecord[1])) return json(request, env, { error: "回收站中没有这笔交易" }, 404);
      const now = new Date().toISOString();
      await env.DB.batch([
        env.DB.prepare("DELETE FROM deleted_trades WHERE trade_id = ?1").bind(restoreRecord[1]),
        env.DB.prepare("INSERT INTO audit_log (trade_id, action, actor, created_at) VALUES (?1, ?2, ?3, ?4)").bind(restoreRecord[1], "trade-restore", user.login, now),
      ]);
      return json(request, env, { ok: true, tradeId: restoreRecord[1], restoredAt: now });
    }

    const match = url.pathname.match(/^\/api\/trades\/(TR-\d+)$/);
    if (match && request.method === "PUT") {
      try {
        const dashboard = await loadDashboard(env);
        if (!dashboard?.trades?.some((trade) => trade.tradeId === match[1])) return json(request, env, { error: "交易编号不存在" }, 404);
        const cleaned = cleanOverride(await request.json());
        const now = new Date().toISOString();
        if (Object.keys(cleaned).length) {
          await env.DB.prepare("INSERT INTO overrides (trade_id, payload, updated_at) VALUES (?1, ?2, ?3) ON CONFLICT(trade_id) DO UPDATE SET payload = excluded.payload, updated_at = excluded.updated_at")
            .bind(match[1], JSON.stringify(cleaned), now).run();
        } else {
          await env.DB.prepare("DELETE FROM overrides WHERE trade_id = ?1").bind(match[1]).run();
        }
        await env.DB.prepare("INSERT INTO audit_log (trade_id, action, actor, created_at) VALUES (?1, ?2, ?3, ?4)").bind(match[1], "save", user.login, now).run();
        return json(request, env, { ok: true, tradeId: match[1], override: cleaned, updatedAt: now });
      } catch (error) { return json(request, env, { error: error.message || "保存失败" }, 400); }
    }
    if (match && request.method === "DELETE") {
      const now = new Date().toISOString();
      await env.DB.batch([
        env.DB.prepare("DELETE FROM overrides WHERE trade_id = ?1").bind(match[1]),
        env.DB.prepare("INSERT INTO audit_log (trade_id, action, actor, created_at) VALUES (?1, ?2, ?3, ?4)").bind(match[1], "delete", user.login, now),
      ]);
      return json(request, env, { ok: true, tradeId: match[1], updatedAt: now });
    }
    return json(request, env, { error: "接口不存在" }, 404);
  },
};
