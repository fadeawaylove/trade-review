const SINA_URL = "https://hq.sinajs.cn/list=";
const MAX_RESPONSE_BYTES = 64 * 1024;
const MAX_QUOTE_AGE_MS = 15 * 60 * 1000;
const MARKET_ANCHOR_STALE_MS = 90 * 60 * 1000;
const MAX_QUOTE_GAP_MS = 120 * 1000;
const AG_CONTRACT = /^AG\d{4}$/;

// 上海期货交易所公告〔2025〕157号。未知年份一律不取数，避免节假日误写入。
const CLOSED_DATES_2026 = new Set([
  "2026-01-01", "2026-01-02", "2026-01-03", "2026-02-15", "2026-02-16", "2026-02-17", "2026-02-18", "2026-02-19", "2026-02-20", "2026-02-21", "2026-02-22", "2026-02-23",
  "2026-04-04", "2026-04-05", "2026-04-06", "2026-05-01", "2026-05-02", "2026-05-03", "2026-05-04", "2026-05-05", "2026-06-19", "2026-06-20", "2026-06-21",
  "2026-09-25", "2026-09-26", "2026-09-27", "2026-10-01", "2026-10-02", "2026-10-03", "2026-10-04", "2026-10-05", "2026-10-06", "2026-10-07",
]);
const NIGHT_CLOSED_DATES = new Set(["2025-12-31", "2026-02-13", "2026-04-03", "2026-04-30", "2026-06-18", "2026-09-24", "2026-09-30"]);

function chinaParts(now) {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(now);
  const field = (type) => parts.find((part) => part.type === type)?.value;
  return { date: `${field("year")}-${field("month")}-${field("day")}`, hour: Number(field("hour")), minute: Number(field("minute")), weekday: new Intl.DateTimeFormat("en-US", { timeZone: "Asia/Shanghai", weekday: "short" }).format(now) };
}

export function isAgTradingTime(now = new Date()) {
  const { date, hour, minute, weekday } = chinaParts(now);
  if (!date.startsWith("2026-")) return false;
  if (CLOSED_DATES_2026.has(date)) return false;
  const clock = hour * 60 + minute;
  const weekdayNumber = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(weekday);
  if (clock >= 9 * 60 && clock < 10 * 60 + 15) return weekdayNumber >= 1 && weekdayNumber <= 5;
  if (clock >= 10 * 60 + 30 && clock < 11 * 60 + 30) return weekdayNumber >= 1 && weekdayNumber <= 5;
  if (clock >= 13 * 60 + 30 && clock < 15 * 60) return weekdayNumber >= 1 && weekdayNumber <= 5;
  if (clock >= 21 * 60) return weekdayNumber >= 1 && weekdayNumber <= 5 && !NIGHT_CLOSED_DATES.has(date);
  if (clock < 150) {
    const prior = new Date(now.getTime() - 24 * 60 * 60 * 1000);
    const priorDate = chinaParts(prior).date;
    return weekdayNumber >= 2 && weekdayNumber <= 6 && !NIGHT_CLOSED_DATES.has(priorDate) && !CLOSED_DATES_2026.has(priorDate);
  }
  return false;
}

function quoteTime(date, time) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date || "") || !/^\d{2}:\d{2}:\d{2}$/.test(time || "")) return null;
  const value = Date.parse(`${date}T${time}+08:00`);
  return Number.isFinite(value) ? value : null;
}

function plausibleAgTradeDate(agDate, wallDate) {
  const agDay = Date.parse(`${agDate}T00:00:00Z`);
  const wallDay = Date.parse(`${wallDate}T00:00:00Z`);
  const gapDays = (agDay - wallDay) / (24 * 60 * 60 * 1000);
  return Number.isInteger(gapDays) && gapDays >= 0 && gapDays <= 3;
}

function field(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : null;
}

function agCandidates(now) {
  const { date } = chinaParts(now);
  const [year, month] = date.split("-").map(Number);
  const result = [];
  // Query one rolling year: it spans Dec/Jan without hard-coding a calendar year.
  for (let offset = 0; offset < 12; offset += 1) {
    const value = new Date(Date.UTC(year, month - 1 + offset, 1));
    result.push(`AG${String(value.getUTCFullYear()).slice(-2)}${String(value.getUTCMonth() + 1).padStart(2, "0")}`);
  }
  return result;
}

function shanghaiHourBucket(now) {
  const { date, hour } = chinaParts(now);
  return `${date}T${String(hour).padStart(2, "0")}`;
}

export function parseSinaQuotes(body, contracts, now = new Date()) {
  const quoted = new Map();
  for (const match of body.matchAll(/var\s+hq_str_([^=]+)="([^"]*)";/g)) {
    if (quoted.has(match[1])) return [];
    quoted.set(match[1], match[2].split(","));
  }
  const xag = quoted.get("hf_XAG");
  if (!xag || xag.length <= 12) return [];
  const xagAnchor = field(xag?.[0]);
  const xagAt = quoteTime(xag?.[12], xag?.[6]);
  if (!xagAnchor || !xagAt || xagAt > now.getTime() || now.getTime() - xagAt > MAX_QUOTE_AGE_MS) return [];
  const result = [];
  for (const contract of contracts) {
    const ag = quoted.get(`nf_${contract}`);
    if (!ag || ag.length <= 17) continue;
    const agAnchor = field(ag?.[8]);
    if (!plausibleAgTradeDate(ag?.[17], xag?.[12])) continue;
    // 新浪国内期货返回的是交易日；夜盘可能已经是下一交易日。
    // 用同一响应里的 XAG 自然日重建时刻，避免把同一分钟误差解析成相差一天。
    const agAt = quoteTime(xag?.[12], ag?.[1]);
    if (!agAnchor || !agAt || agAt > now.getTime() || now.getTime() - agAt > MAX_QUOTE_AGE_MS || Math.abs(agAt - xagAt) > MAX_QUOTE_GAP_MS) continue;
    // Captured live on 2026-08-25 from multiple nf_AG contracts: index 13 is
    // volume and index 14 is open interest. Reject rather than infer a shift.
    const volume = field(ag?.[13]);
    const openInterest = field(ag?.[14]);
    if (!volume || !openInterest) continue;
    result.push({ contract, xagAnchor, agAnchor, volume, openInterest, xagQuoteAt: new Date(xagAt).toISOString(), agQuoteAt: new Date(agAt).toISOString() });
  }
  return result;
}

export function selectAgMainContract(quotes) {
  if (!quotes.length) return null;
  const maxOpenInterest = Math.max(...quotes.map((quote) => quote.openInterest));
  const byOpenInterest = quotes.filter((quote) => quote.openInterest === maxOpenInterest);
  const maxVolume = Math.max(...byOpenInterest.map((quote) => quote.volume));
  const winners = byOpenInterest.filter((quote) => quote.volume === maxVolume);
  return winners.length === 1 ? winners[0] : null;
}

export async function observeAgMainContract(db, leader, now) {
  const observedAt = now.toISOString();
  const hourBucket = shanghaiHourBucket(now);
  await db.prepare("INSERT OR IGNORE INTO silver_ag_main_contract_state (singleton) VALUES (1)").run();
  // D1 serializes this one-row UPDATE. The old state is read by each CASE, so
  // duplicate Cron/retry deliveries in the same Shanghai hour cannot add a vote.
  await db.prepare(`UPDATE silver_ag_main_contract_state SET
    current_contract = CASE
      WHEN current_contract IS NULL THEN ?1
      WHEN ?1 <= current_contract THEN current_contract
      WHEN candidate_contract = ?1 AND candidate_last_hour_bucket <> ?2 AND candidate_hour_count >= 2 THEN ?1
      ELSE current_contract END,
    candidate_contract = CASE
      WHEN current_contract IS NULL OR ?1 <= current_contract THEN NULL
      WHEN candidate_contract = ?1 AND candidate_last_hour_bucket <> ?2 AND candidate_hour_count >= 2 THEN NULL
      ELSE ?1 END,
    candidate_hour_count = CASE
      WHEN current_contract IS NULL OR ?1 <= current_contract THEN 0
      WHEN candidate_contract = ?1 AND candidate_last_hour_bucket <> ?2 AND candidate_hour_count >= 2 THEN 0
      WHEN candidate_contract = ?1 AND candidate_last_hour_bucket = ?2 THEN candidate_hour_count
      WHEN candidate_contract = ?1 THEN candidate_hour_count + 1
      ELSE 1 END,
    candidate_last_hour_bucket = CASE
      WHEN current_contract IS NULL OR ?1 <= current_contract THEN NULL
      WHEN candidate_contract = ?1 AND candidate_last_hour_bucket <> ?2 AND candidate_hour_count >= 2 THEN NULL
      ELSE ?2 END,
    selected_at = CASE
      WHEN current_contract IS NULL THEN ?3
      WHEN candidate_contract = ?1 AND candidate_last_hour_bucket <> ?2 AND candidate_hour_count >= 2 THEN ?3
      ELSE selected_at END,
    observed_at = ?3, error = NULL WHERE singleton = 1`).bind(leader.contract, hourBucket, observedAt).run();
}

async function limitedText(response) {
  const reader = response.body?.getReader();
  if (!reader) return "";
  const chunks = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_RESPONSE_BYTES) throw new Error("response_too_large");
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return new TextDecoder("gb18030").decode(bytes);
}

export async function syncSilverMarketAnchors(db, now = new Date(), { fetchImpl = fetch, log = console } = {}) {
  const calendarDate = chinaParts(now).date;
  if (!calendarDate.startsWith("2026-")) {
    log.warn("silver_market_anchor", { outcome: "skipped", reason: "calendar_unconfigured", calendarDate });
    return { skipped: "calendar_unconfigured" };
  }
  if (!isAgTradingTime(now)) return { skipped: "outside_trading_time" };
  const rows = await db.prepare("SELECT DISTINCT contract FROM silver_target_settings WHERE contract GLOB 'AG[0-9][0-9][0-9][0-9]'").all();
  const contracts = [...new Set([...agCandidates(now), ...(rows.results || []).map((row) => String(row.contract || ""))].filter((contract) => AG_CONTRACT.test(contract)))];
  let response;
  try {
    response = await fetchImpl(`${SINA_URL}hf_XAG,${contracts.map((contract) => `nf_${contract}`).join(",")}`, { headers: { Referer: "https://finance.sina.com.cn/" }, redirect: "error", signal: AbortSignal.timeout(8000) });
    if (!response.ok) throw new Error(`http_${response.status}`);
    const quotes = parseSinaQuotes(await limitedText(response), contracts, now);
    if (!quotes.length) throw new Error("invalid_quotes");
    const leader = selectAgMainContract(quotes);
    const fetchedAt = now.toISOString();
    await db.batch(quotes.map((quote) => db.prepare("INSERT INTO silver_market_anchors (contract, xag_anchor, ag_anchor, xag_quote_at, ag_quote_at, fetched_at, source, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'sina-finance', ?6) ON CONFLICT(contract) DO UPDATE SET xag_anchor = excluded.xag_anchor, ag_anchor = excluded.ag_anchor, xag_quote_at = excluded.xag_quote_at, ag_quote_at = excluded.ag_quote_at, fetched_at = excluded.fetched_at, source = excluded.source, updated_at = excluded.updated_at").bind(quote.contract, quote.xagAnchor, quote.agAnchor, quote.xagQuoteAt, quote.agQuoteAt, fetchedAt)));
    if (leader) await observeAgMainContract(db, leader, now);
    log.info("silver_market_anchor", { outcome: "updated", contracts: quotes.length, rejected: contracts.length - quotes.length, leader: leader?.contract || null });
    return { updated: quotes.length, rejected: contracts.length - quotes.length, leader: leader?.contract || null };
  } catch (error) {
    log.warn("silver_market_anchor", { outcome: "rejected", reason: error?.message || "unknown" });
    return { skipped: "fetch_or_validation_failed" };
  }
}

export function marketAnchorFromRow(row, now = new Date()) {
  if (!row || !AG_CONTRACT.test(String(row.contract || ""))) return null;
  const fetched = Date.parse(row.fetched_at);
  return { contract: row.contract, xagAnchor: row.xag_anchor, agAnchor: row.ag_anchor, xagQuoteAt: row.xag_quote_at, agQuoteAt: row.ag_quote_at, fetchedAt: row.fetched_at, source: row.source || "sina-finance", stale: !Number.isFinite(fetched) || now.getTime() - fetched > MARKET_ANCHOR_STALE_MS };
}
