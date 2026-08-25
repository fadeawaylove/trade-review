import { marketAnchorFromRow } from "./silver-market-anchor.js";

const DEFAULT_TOLERANCE_PERCENT = 0.5;
const MAX_TOLERANCE_PERCENT = 10;
const AG_CONTRACT = /^AG\d{4}$/;

function optionalPositiveNumber(value, label) {
  if (value === "" || value === null || value === undefined) return null;
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) throw new Error(`${label}必须大于 0`);
  return number;
}

export function cleanSilverTargetSettings(value) {
  const source = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  const contract = String(source.contract ?? "").trim().toUpperCase();
  if (contract && !AG_CONTRACT.test(contract)) {
    throw new Error("AG 合约必须为 AG 加四位数字，例如 AG2612");
  }
  const tolerancePercent = source.tolerancePercent === "" || source.tolerancePercent === null || source.tolerancePercent === undefined
    ? DEFAULT_TOLERANCE_PERCENT
    : Number(source.tolerancePercent);
  if (!Number.isFinite(tolerancePercent) || tolerancePercent < 0 || tolerancePercent > MAX_TOLERANCE_PERCENT) {
    throw new Error(`映射容差必须在 0–${MAX_TOLERANCE_PERCENT}% 之间`);
  }
  return {
    contract,
    xagAnchor: optionalPositiveNumber(source.xagAnchor, "XAGUSD 锚点"),
    agAnchor: optionalPositiveNumber(source.agAnchor, "AG 锚点"),
    xagTarget: optionalPositiveNumber(source.xagTarget, "XAGUSD 目标价"),
    tolerancePercent,
  };
}

function settingsFromRow(row) {
  if (!row) return null;
  return {
    contract: row.contract || "",
    xagAnchor: row.xag_anchor ?? null,
    agAnchor: row.ag_anchor ?? null,
    xagTarget: row.xag_target ?? null,
    tolerancePercent: row.tolerance_percent ?? DEFAULT_TOLERANCE_PERCENT,
    updatedAt: row.updated_at,
  };
}

function requestedMode(value) {
  if (!value || typeof value !== "object" || Array.isArray(value) || !Object.hasOwn(value, "mode")) return null;
  if (value.mode !== "auto" && value.mode !== "manual") throw new Error("合约模式必须为 auto 或 manual");
  return value.mode;
}

function contractSelection(settings, preference, state) {
  const manualContract = settings && AG_CONTRACT.test(settings.contract) ? settings.contract : null;
  const mode = preference?.mode || (manualContract ? "manual" : "auto");
  const autoContract = AG_CONTRACT.test(String(state?.current_contract || "")) ? state.current_contract : null;
  const selected = { mode, autoContract, manualContract, effectiveContract: mode === "auto" ? autoContract : manualContract, selectedAt: state?.selected_at ?? null, observedAt: state?.observed_at ?? null };
  if (state?.error) selected.error = state.error;
  return selected;
}

export async function handleSilverTargetSettings(request, env, user, url, helpers) {
  if (url.pathname !== "/api/silver-target-settings") return null;
  const { json, withD1Retry } = helpers;
  const login = String(user.login || "").trim().toLowerCase();

  if (request.method === "GET") {
    const row = await withD1Retry(() => env.DB.prepare(
      "SELECT contract, xag_anchor, ag_anchor, xag_target, tolerance_percent, updated_at FROM silver_target_settings WHERE login = ?1"
    ).bind(login).first());
    const settings = settingsFromRow(row);
    const preference = await withD1Retry(() => env.DB.prepare("SELECT mode FROM silver_target_contract_preferences WHERE login = ?1").bind(login).first());
    const state = await withD1Retry(() => env.DB.prepare("SELECT current_contract, selected_at, observed_at, error FROM silver_ag_main_contract_state WHERE singleton = 1").first());
    const selection = contractSelection(settings, preference, state);
    const marketRow = selection.effectiveContract
      ? await withD1Retry(() => env.DB.prepare(
        "SELECT contract, xag_anchor, ag_anchor, xag_quote_at, ag_quote_at, fetched_at, source FROM silver_market_anchors WHERE contract = ?1"
      ).bind(selection.effectiveContract).first())
      : null;
    const marketAnchor = marketAnchorFromRow(marketRow);
    return json(request, env, { settings, contractSelection: selection, marketAnchor });
  }

  if (request.method === "PUT") {
    try {
      const body = await request.json();
      const settings = cleanSilverTargetSettings(body);
      const mode = requestedMode(body);
      if (mode === "manual" && !AG_CONTRACT.test(settings.contract)) throw new Error("手动模式必须指定合法 AG 合约");
      const now = new Date().toISOString();
      await withD1Retry(() => env.DB.prepare(
        "INSERT INTO silver_target_settings (login, contract, xag_anchor, ag_anchor, xag_target, tolerance_percent, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7) ON CONFLICT(login) DO UPDATE SET contract = excluded.contract, xag_anchor = excluded.xag_anchor, ag_anchor = excluded.ag_anchor, xag_target = excluded.xag_target, tolerance_percent = excluded.tolerance_percent, updated_at = excluded.updated_at"
      ).bind(login, settings.contract, settings.xagAnchor, settings.agAnchor, settings.xagTarget, settings.tolerancePercent, now).run());
      if (mode) await withD1Retry(() => env.DB.prepare("INSERT INTO silver_target_contract_preferences (login, mode, updated_at) VALUES (?1, ?2, ?3) ON CONFLICT(login) DO UPDATE SET mode = excluded.mode, updated_at = excluded.updated_at").bind(login, mode, now).run());
      return json(request, env, { ok: true, settings: { ...settings, updatedAt: now } });
    } catch (error) {
      return json(request, env, { error: error.message || "白银换算设置保存失败" }, 400);
    }
  }

  if (request.method === "DELETE") {
    await withD1Retry(() => env.DB.prepare("DELETE FROM silver_target_settings WHERE login = ?1").bind(login).run());
    return json(request, env, { ok: true, settings: null });
  }

  return json(request, env, { error: "请求方法不受支持" }, 405);
}
