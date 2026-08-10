export const TRASH_RETENTION_DAYS = 30;

const DAY_MS = 24 * 60 * 60 * 1000;

function round2(value) {
  return Math.round((Number(value) + Number.EPSILON) * 100) / 100;
}

function tradeNumber(tradeId) {
  const match = /^TR-(\d+)$/.exec(String(tradeId || ""));
  return match ? Number(match[1]) : -1;
}

function latestAssignedTradeId(payload) {
  const candidates = [payload?.meta?.lastAssignedTradeId, ...(payload?.trades || []).map((trade) => trade.tradeId)]
    .filter((tradeId) => tradeNumber(tradeId) >= 0);
  return candidates.sort((left, right) => tradeNumber(right) - tradeNumber(left))[0] || "";
}

export function trashPurgeAt(deletedAt) {
  const timestamp = Date.parse(deletedAt);
  if (!Number.isFinite(timestamp)) return "";
  return new Date(timestamp + TRASH_RETENTION_DAYS * DAY_MS).toISOString();
}

export function isTrashExpired(deletedAt, now = new Date()) {
  const purgeAt = Date.parse(trashPurgeAt(deletedAt));
  return Number.isFinite(purgeAt) && purgeAt < now.getTime();
}

export function removeTradeFromPayload(source, tradeId) {
  const payload = typeof source === "string" ? JSON.parse(source) : JSON.parse(JSON.stringify(source || {}));
  const trades = Array.isArray(payload.trades) ? payload.trades : [];
  const removedTrade = trades.find((trade) => trade.tradeId === tradeId) || null;
  const lastAssignedTradeId = latestAssignedTradeId(payload);
  let cumulativePnl = 0;
  let peakCumulative = 0;

  payload.trades = trades
    .filter((trade) => trade.tradeId !== tradeId)
    .map((trade) => {
      cumulativePnl = round2(cumulativePnl + Number(trade.netPnl || 0));
      peakCumulative = Math.max(peakCumulative, cumulativePnl, 0);
      return {
        ...trade,
        cumulativePnl,
        drawdown: round2(cumulativePnl - peakCumulative),
      };
    });
  payload.meta = { ...(payload.meta || {}) };
  if (lastAssignedTradeId) payload.meta.lastAssignedTradeId = lastAssignedTradeId;
  return { payload, removedTrade };
}

export async function permanentlyDeleteTrade(db, tradeId, now = new Date()) {
  const deleted = await db.prepare(
    "SELECT trade_id, deleted_at FROM deleted_trades WHERE trade_id = ?1",
  ).bind(tradeId).first();
  if (!deleted) return null;

  const dataset = await db.prepare("SELECT payload, updated_at FROM dataset WHERE id = 1").first();
  if (!dataset?.payload) throw new Error("云端底稿尚未初始化");

  const updatedAt = now.toISOString();
  const transformed = removeTradeFromPayload(dataset.payload, tradeId);
  transformed.payload.meta.lastUpdated = updatedAt.slice(0, 10);
  const nextPayload = JSON.stringify(transformed.payload);

  await db.batch([
    db.prepare("UPDATE dataset SET payload = ?1, updated_at = ?2 WHERE id = 1 AND payload = ?3")
      .bind(nextPayload, updatedAt, dataset.payload),
    db.prepare(
      "INSERT INTO dataset (id, payload, updated_at) SELECT 1, '{}', 'trade-purge-cas-failed' WHERE changes() <> 1",
    ),
    db.prepare("DELETE FROM overrides WHERE trade_id = ?1").bind(tradeId),
    db.prepare("DELETE FROM trade_attachments WHERE trade_id = ?1").bind(tradeId),
    db.prepare("DELETE FROM access_history WHERE resource_type = 'trade' AND resource_id = ?1").bind(tradeId),
    db.prepare(
      "UPDATE articles SET trade_ids_json = COALESCE((SELECT json_group_array(value) FROM json_each(articles.trade_ids_json) WHERE value <> ?1), '[]') WHERE EXISTS (SELECT 1 FROM json_each(articles.trade_ids_json) WHERE value = ?1)",
    ).bind(tradeId),
    db.prepare(
      "UPDATE article_versions SET trade_ids_json = COALESCE((SELECT json_group_array(value) FROM json_each(article_versions.trade_ids_json) WHERE value <> ?1), '[]') WHERE EXISTS (SELECT 1 FROM json_each(article_versions.trade_ids_json) WHERE value = ?1)",
    ).bind(tradeId),
    db.prepare("DELETE FROM article_trade_links WHERE trade_id = ?1").bind(tradeId),
    db.prepare("DELETE FROM audit_log WHERE trade_id = ?1").bind(tradeId),
    db.prepare("DELETE FROM deleted_trades WHERE trade_id = ?1").bind(tradeId),
  ]);

  return {
    tradeId,
    purgedAt: updatedAt,
    deletedAt: deleted.deleted_at,
    removed: Boolean(transformed.removedTrade),
  };
}

export async function purgeExpiredTrades(db, now = new Date()) {
  const cutoff = new Date(now.getTime() - TRASH_RETENTION_DAYS * DAY_MS).toISOString();
  const rows = await db.prepare(
    "SELECT trade_id FROM deleted_trades WHERE deleted_at < ?1 ORDER BY deleted_at ASC LIMIT 100",
  ).bind(cutoff).all();
  let purgedCount = 0;
  for (const row of rows.results || []) {
    if (await permanentlyDeleteTrade(db, row.trade_id, now)) purgedCount += 1;
  }
  return { purgedCount, cutoff };
}
