const RESOURCE_TYPES = new Set(["trade", "article"]);
const MAX_TITLE_LENGTH = 160;
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 100;
const DEFAULT_RETENTION_DAYS = 180;

function cleanResourceType(value) {
  const normalized = String(value || "").trim().toLowerCase();
  if (!RESOURCE_TYPES.has(normalized)) throw new Error("访问对象类型无效");
  return normalized;
}

function cleanResourceId(value) {
  const id = String(value || "").trim();
  if (!id || id.length > 80) throw new Error("访问对象编号无效");
  return id;
}

function cleanTitle(value) {
  return String(value || "").replace(/\s+/g, " ").trim().slice(0, MAX_TITLE_LENGTH);
}

function cleanLimit(value) {
  const limit = Number(value || DEFAULT_LIMIT);
  if (!Number.isFinite(limit)) return DEFAULT_LIMIT;
  return Math.min(MAX_LIMIT, Math.max(1, Math.trunc(limit)));
}

function retentionDays(env) {
  const days = Number(env.ACCESS_HISTORY_RETENTION_DAYS || DEFAULT_RETENTION_DAYS);
  return Number.isFinite(days) && days > 0 ? Math.trunc(days) : DEFAULT_RETENTION_DAYS;
}

function historyItem(row) {
  return {
    id: row.id,
    actor: row.actor,
    resourceType: row.resource_type,
    resourceId: row.resource_id,
    action: row.action,
    title: row.title || "",
    createdAt: row.created_at,
  };
}

async function runStatements(env, statements) {
  if (typeof env.DB.batch === "function") return env.DB.batch(statements);
  const results = [];
  for (const statement of statements) results.push(await statement.run());
  return results;
}

export async function recordAccessHistory(env, user, payload) {
  const resourceType = cleanResourceType(payload?.resourceType);
  const resourceId = cleanResourceId(payload?.resourceId);
  const title = cleanTitle(payload?.title);
  const now = new Date().toISOString();
  const cutoff = new Date(Date.now() - retentionDays(env) * 24 * 60 * 60 * 1000).toISOString();
  await runStatements(env, [
    env.DB.prepare("INSERT INTO access_history (actor, resource_type, resource_id, action, title, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)")
      .bind(user.login, resourceType, resourceId, "view", title, now),
    env.DB.prepare("DELETE FROM access_history WHERE created_at < ?1").bind(cutoff),
  ]);
  return { ok: true, createdAt: now };
}

export async function handleAccessHistoryRequest(request, env, user, url, { json }) {
  if (url.pathname !== "/api/access-history") return null;
  if (request.method === "POST") {
    try {
      const result = await recordAccessHistory(env, user, await request.json());
      return json(request, env, result, 201);
    } catch (error) {
      return json(request, env, { error: error.message || "访问记录写入失败" }, 400);
    }
  }
  if (request.method !== "GET") return json(request, env, { error: "接口不存在" }, 404);
  if (user.role !== "editor") return json(request, env, { error: "当前账号无权查看访问历史" }, 403);

  const where = [];
  const args = [];
  const actor = String(url.searchParams.get("actor") || "").trim();
  const resourceType = String(url.searchParams.get("resourceType") || "").trim().toLowerCase();
  if (actor) {
    args.push(actor);
    where.push(`actor = ?${args.length}`);
  }
  if (resourceType) {
    if (!RESOURCE_TYPES.has(resourceType)) return json(request, env, { error: "访问对象类型无效" }, 400);
    args.push(resourceType);
    where.push(`resource_type = ?${args.length}`);
  }
  const limit = cleanLimit(url.searchParams.get("limit"));
  args.push(limit);
  const sql = `SELECT id, actor, resource_type, resource_id, action, title, created_at FROM access_history${where.length ? ` WHERE ${where.join(" AND ")}` : ""} ORDER BY created_at DESC, id DESC LIMIT ?${args.length}`;
  const rows = await env.DB.prepare(sql).bind(...args).all();
  return json(request, env, { history: (rows.results || []).map(historyItem) });
}
