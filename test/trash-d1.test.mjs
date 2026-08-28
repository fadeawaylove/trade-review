import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import test from "node:test";
import { Miniflare } from "miniflare";

import { permanentlyDeleteTrade } from "../worker/src/trash.js";

async function executeSql(db, sql) {
  const statements = [];
  let current = [];
  let trigger = false;
  for (const sourceLine of String(sql || "").replaceAll("\r", "").split("\n")) {
    const line = sourceLine.trim();
    if (!line || line.startsWith("--")) continue;
    if (!current.length) trigger = /^CREATE\s+TRIGGER\b/i.test(line);
    current.push(line);
    const complete = trigger ? /^END;$/i.test(line) : /;$/.test(line);
    if (!complete) continue;
    statements.push(current.join(" "));
    current = [];
    trigger = false;
  }
  if (current.length) throw new Error("测试 SQL 包含未闭合的语句");
  await db.exec(statements.join("\n"));
}

test("真实 D1 批次会原子移除交易及全部结构化关联", async () => {
  const miniflare = new Miniflare({
    modules: true,
    script: "export default { fetch() { return new Response('ok'); } }",
    d1Databases: { DB: "trade-trash-test" },
  });
  try {
    const db = await miniflare.getD1Database("DB");
    const schema = await fs.readFile(new URL("../worker/schema.sql", import.meta.url), "utf8");
    await executeSql(db, schema);
    const payload = JSON.stringify({
      meta: { fillCount: 4 },
      trades: [
        { tradeId: "TR-0001", netPnl: 100, cumulativePnl: 100, drawdown: 0 },
        { tradeId: "TR-0002", netPnl: -40, cumulativePnl: 60, drawdown: -40 },
      ],
    }).replaceAll("'", "''");
    await executeSql(db, `
      INSERT INTO dataset (id, payload, updated_at) VALUES (1, '${payload}', '2026-08-01T00:00:00.000Z');
      INSERT INTO overrides (trade_id, payload, updated_at) VALUES ('TR-0002', '{}', '2026-08-01T00:00:00.000Z');
      INSERT INTO trade_attachments (id, trade_id, file_name, mime_type, byte_size, image_data, created_by, created_at)
        VALUES ('11111111-1111-4111-8111-111111111111', 'TR-0002', 'chart.png', 'image/png', 1, X'89', 'editor', '2026-08-01T00:00:00.000Z');
      INSERT INTO audit_log (trade_id, action, actor, created_at) VALUES ('TR-0002', 'trade-delete', 'editor', '2026-08-01T00:00:00.000Z');
      INSERT INTO access_history (actor, resource_type, resource_id, action, title, created_at)
        VALUES ('editor', 'trade', 'TR-0002', 'view', '待删除交易', '2026-08-01T00:00:00.000Z');
      INSERT INTO deleted_trades (trade_id, deleted_by, deleted_at) VALUES ('TR-0002', 'editor', '2026-08-01T00:00:00.000Z');
      INSERT INTO articles (id, title, content_md, excerpt, status, tags_json, trade_ids_json, revision, created_by, updated_by, created_at, updated_at)
        VALUES ('22222222-2222-4222-8222-222222222222', '复盘', '', '', 'draft', '[]', '["TR-0001","TR-0002"]', 1, 'editor', 'editor', '2026-08-01T00:00:00.000Z', '2026-08-01T00:00:00.000Z');
      INSERT INTO article_versions (article_id, revision, title, content_md, status, tags_json, trade_ids_json, created_by, created_at)
        VALUES ('22222222-2222-4222-8222-222222222222', 1, '复盘', '', 'draft', '[]', '["TR-0001","TR-0002"]', 'editor', '2026-08-01T00:00:00.000Z');
      INSERT INTO article_trade_links (article_id, trade_id, created_at)
        VALUES ('22222222-2222-4222-8222-222222222222', 'TR-0002', '2026-08-01T00:00:00.000Z');
    `);

    const result = await permanentlyDeleteTrade(db, "TR-0002", new Date("2026-08-10T06:00:00.000Z"));
    assert.equal(result.tradeId, "TR-0002");

    const dataset = await db.prepare("SELECT payload FROM dataset WHERE id = 1").first();
    const stored = JSON.parse(dataset.payload);
    assert.deepEqual(stored.trades.map((trade) => trade.tradeId), ["TR-0001"]);
    assert.equal(stored.meta.lastAssignedTradeId, "TR-0002");
    for (const [table, where] of [
      ["overrides", "trade_id = 'TR-0002'"],
      ["trade_attachments", "trade_id = 'TR-0002'"],
      ["audit_log", "trade_id = 'TR-0002'"],
      ["access_history", "resource_type = 'trade' AND resource_id = 'TR-0002'"],
      ["article_trade_links", "trade_id = 'TR-0002'"],
      ["article_trade_links_derived", "trade_id = 'TR-0002'"],
      ["deleted_trades", "trade_id = 'TR-0002'"],
    ]) {
      const count = await db.prepare(`SELECT COUNT(*) AS count FROM ${table} WHERE ${where}`).first();
      assert.equal(count.count, 0, table);
    }
    const article = await db.prepare("SELECT trade_ids_json FROM articles").first();
    const version = await db.prepare("SELECT trade_ids_json FROM article_versions").first();
    assert.deepEqual(JSON.parse(article.trade_ids_json), ["TR-0001"]);
    assert.deepEqual(JSON.parse(version.trade_ids_json), ["TR-0001"]);
    assert.equal(await permanentlyDeleteTrade(db, "TR-0002"), null);
  } finally {
    await miniflare.dispose();
  }
});
