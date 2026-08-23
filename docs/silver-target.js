const DEFAULT_TOLERANCE_PERCENT = 0.5;
const MAX_TOLERANCE_PERCENT = 10;
const LEGACY_STORAGE_KEY = "tradeReviewSilverTargetV1";

function positiveNumber(value, label) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) throw new Error(`${label}必须大于 0`);
  return number;
}

function optionalPositiveNumber(value, label) {
  if (value === "" || value === null || value === undefined) return null;
  return positiveNumber(value, label);
}

export function calculateSilverTarget({ xagAnchor, agAnchor, xagTarget, tolerancePercent = DEFAULT_TOLERANCE_PERCENT }) {
  const normalizedXagAnchor = positiveNumber(xagAnchor, "XAGUSD 锚点");
  const normalizedAgAnchor = positiveNumber(agAnchor, "AG 锚点");
  const normalizedXagTarget = positiveNumber(xagTarget, "XAGUSD 目标价");
  const normalizedTolerance = Number(tolerancePercent);
  if (!Number.isFinite(normalizedTolerance) || normalizedTolerance < 0 || normalizedTolerance > MAX_TOLERANCE_PERCENT) {
    throw new Error(`映射容差必须在 0–${MAX_TOLERANCE_PERCENT}% 之间`);
  }

  const anchorRatio = normalizedAgAnchor / normalizedXagAnchor;
  const changeRate = normalizedXagTarget / normalizedXagAnchor - 1;
  const agTarget = normalizedXagTarget * anchorRatio;
  const agChange = agTarget - normalizedAgAnchor;
  const toleranceRate = normalizedTolerance / 100;

  return {
    anchorRatio,
    changeRate,
    agTarget,
    agChange,
    rangeLow: agTarget * (1 - toleranceRate),
    rangeHigh: agTarget * (1 + toleranceRate),
    direction: changeRate > 0 ? "rise" : changeRate < 0 ? "fall" : "flat",
    tolerancePercent: normalizedTolerance,
  };
}

export function normalizeSilverSettings(value) {
  const source = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  const contract = String(source.contract ?? "").trim().toUpperCase();
  if (contract.length > 16 || (contract && !/^[A-Z0-9._-]+$/.test(contract))) throw new Error("AG 合约格式不正确");
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

const numberFormat = new Intl.NumberFormat("zh-CN", { maximumFractionDigits: 0 });
const ratioFormat = new Intl.NumberFormat("zh-CN", { minimumFractionDigits: 2, maximumFractionDigits: 4 });

function formatSignedPercent(value) {
  const sign = value > 0 ? "+" : "";
  return `${sign}${(value * 100).toFixed(2)}%`;
}

function formatSignedPoints(value) {
  const rounded = Math.round(value);
  return `${rounded > 0 ? "+" : ""}${numberFormat.format(rounded)} 点`;
}

function readLegacyInputs() {
  try { return JSON.parse(localStorage.getItem(LEGACY_STORAGE_KEY) || "null") || {}; }
  catch { return {}; }
}

function clearLegacyInputs() {
  try { localStorage.removeItem(LEGACY_STORAGE_KEY); } catch {}
}

function hasMeaningfulSettings(settings) {
  return Boolean(settings.contract || settings.xagAnchor !== null || settings.agAnchor !== null || settings.xagTarget !== null
    || settings.tolerancePercent !== DEFAULT_TOLERANCE_PERCENT);
}

const settingsFingerprint = (settings) => JSON.stringify(normalizeSilverSettings(settings));

export function initSilverTargetCalculator({ root = document, apiFetch = null, debounceMs = 650 } = {}) {
  const byId = (id) => root.getElementById(id);
  const trigger = byId("silverTargetButton");
  const overlay = byId("silverTargetDialog");
  const form = byId("silverTargetForm");
  if (!trigger || !overlay || !form) return null;

  const fields = {
    contract: byId("silverContract"),
    xagAnchor: byId("silverXagAnchor"),
    agAnchor: byId("silverAgAnchor"),
    xagTarget: byId("silverXagTarget"),
    tolerancePercent: byId("silverTolerance"),
  };
  const resultNodes = {
    contract: byId("silverResultContract"),
    target: byId("silverAgTarget"),
    range: byId("silverAgRange"),
    move: byId("silverExpectedMove"),
    points: byId("silverAgPoints"),
    ratio: byId("silverAnchorRatio"),
    state: byId("silverResultState"),
    error: byId("silverTargetError"),
    sync: byId("silverSyncState"),
  };
  let cloudReady = false;
  let connectPromise = null;
  let saveTimer = 0;
  let syncChain = Promise.resolve();
  let syncRevision = 0;
  let sessionEpoch = 0;
  let lastFingerprint = "";

  function currentValues() {
    return Object.fromEntries(Object.entries(fields).map(([key, field]) => [key, field?.value ?? ""]));
  }

  function applySettings(value) {
    const settings = normalizeSilverSettings(value);
    fields.contract.value = settings.contract;
    fields.xagAnchor.value = settings.xagAnchor ?? "";
    fields.agAnchor.value = settings.agAnchor ?? "";
    fields.xagTarget.value = settings.xagTarget ?? "";
    fields.tolerancePercent.value = settings.tolerancePercent;
    return settings;
  }

  function setSyncState(state, text) {
    resultNodes.sync.dataset.state = state;
    resultNodes.sync.textContent = text;
    resultNodes.sync.disabled = !["error", "offline"].includes(state);
  }

  function clearResult() {
    resultNodes.target.textContent = "—";
    resultNodes.range.textContent = "等待完整锚点";
    resultNodes.move.textContent = "—";
    resultNodes.points.textContent = "—";
    resultNodes.ratio.textContent = "—";
    resultNodes.contract.textContent = fields.contract.value.trim().toUpperCase() || "AG";
    resultNodes.state.dataset.direction = "flat";
  }

  function render({ reportErrors = false } = {}) {
    const values = currentValues();
    resultNodes.error.hidden = true;
    const requiredComplete = [values.xagAnchor, values.agAnchor, values.xagTarget].every((value) => String(value).trim());
    if (!requiredComplete) {
      clearResult();
      return null;
    }
    try {
      const result = calculateSilverTarget(values);
      resultNodes.contract.textContent = values.contract.trim().toUpperCase() || "AG";
      resultNodes.target.textContent = numberFormat.format(Math.round(result.agTarget));
      resultNodes.range.textContent = `${numberFormat.format(Math.round(result.rangeLow))} – ${numberFormat.format(Math.round(result.rangeHigh))}`;
      resultNodes.move.textContent = formatSignedPercent(result.changeRate);
      resultNodes.points.textContent = formatSignedPoints(result.agChange);
      resultNodes.ratio.textContent = ratioFormat.format(result.anchorRatio);
      resultNodes.state.dataset.direction = result.direction;
      return result;
    } catch (error) {
      clearResult();
      if (reportErrors) {
        resultNodes.error.textContent = error.message;
        resultNodes.error.hidden = false;
      }
      return null;
    }
  }

  function enqueueSync(operation, successFingerprint = null) {
    const revision = ++syncRevision;
    setSyncState("saving", "正在同步…");
    syncChain = syncChain.catch(() => {}).then(operation).then((payload) => {
      if (successFingerprint !== null) lastFingerprint = successFingerprint;
      if (revision === syncRevision) setSyncState("synced", "已同步到云端");
      return payload;
    }).catch((error) => {
      if (revision === syncRevision) setSyncState("error", "同步失败 · 点击重试");
      resultNodes.error.textContent = error.message || "云端同步失败";
      resultNodes.error.hidden = false;
      return null;
    });
    return syncChain;
  }

  function flushSave() {
    clearTimeout(saveTimer);
    saveTimer = 0;
    if (!cloudReady || !apiFetch) return Promise.resolve(null);
    let settings;
    try { settings = normalizeSilverSettings(currentValues()); }
    catch (error) {
      setSyncState("error", "输入有误 · 点击重试");
      resultNodes.error.textContent = error.message;
      resultNodes.error.hidden = false;
      return Promise.resolve(null);
    }
    const fingerprint = settingsFingerprint(settings);
    if (fingerprint === lastFingerprint) {
      setSyncState("synced", "已同步到云端");
      return Promise.resolve(settings);
    }
    return enqueueSync(
      () => apiFetch("/api/silver-target-settings", { method: "PUT", body: JSON.stringify(settings) }),
      fingerprint,
    );
  }

  function scheduleSave({ immediate = false } = {}) {
    if (!cloudReady) {
      setSyncState("offline", "云端未连接 · 点击重试");
      return;
    }
    clearTimeout(saveTimer);
    setSyncState("pending", "等待同步…");
    saveTimer = setTimeout(flushSave, immediate ? 0 : debounceMs);
  }

  async function connect() {
    if (cloudReady) return true;
    if (!apiFetch) {
      setSyncState("offline", "云端同步不可用");
      return false;
    }
    if (connectPromise) return connectPromise;
    const epoch = ++sessionEpoch;
    setSyncState("loading", "正在读取云端…");
    connectPromise = (async () => {
      const payload = await apiFetch("/api/silver-target-settings");
      if (epoch !== sessionEpoch) return false;
      let settings = payload.settings ? normalizeSilverSettings(payload.settings) : null;
      if (!settings) {
        let legacy = null;
        try { legacy = normalizeSilverSettings(readLegacyInputs()); } catch {}
        if (legacy && hasMeaningfulSettings(legacy)) {
          const migrated = await apiFetch("/api/silver-target-settings", { method: "PUT", body: JSON.stringify(legacy) });
          if (epoch !== sessionEpoch) return false;
          settings = normalizeSilverSettings(migrated.settings || legacy);
        }
      }
      settings ||= normalizeSilverSettings({});
      applySettings(settings);
      render();
      clearLegacyInputs();
      lastFingerprint = settingsFingerprint(settings);
      cloudReady = true;
      setSyncState("synced", "已同步到云端");
      return true;
    })().catch((error) => {
      if (epoch === sessionEpoch) {
        cloudReady = false;
        setSyncState("error", "同步失败 · 点击重试");
        resultNodes.error.textContent = error.message || "读取云端锚点失败";
        resultNodes.error.hidden = false;
      }
      return false;
    }).finally(() => { connectPromise = null; });
    return connectPromise;
  }

  function disconnect() {
    sessionEpoch += 1;
    syncRevision += 1;
    cloudReady = false;
    connectPromise = null;
    clearTimeout(saveTimer);
    form.reset();
    fields.tolerancePercent.value = String(DEFAULT_TOLERANCE_PERCENT);
    render();
    setSyncState("offline", "登录后云同步");
  }

  function open() {
    overlay.hidden = false;
    document.body.classList.add("silver-target-open");
    if (!cloudReady) connect();
    const firstEmpty = [fields.xagAnchor, fields.agAnchor, fields.xagTarget].find((field) => !field.value);
    (firstEmpty || fields.xagTarget).focus();
    render();
  }

  function close() {
    if (overlay.hidden) return;
    overlay.hidden = true;
    document.body.classList.remove("silver-target-open");
    trigger.focus();
  }

  try { applySettings(readLegacyInputs()); } catch { applySettings({}); }
  render();
  setSyncState("offline", "登录后云同步");

  trigger.addEventListener("click", open);
  byId("silverTargetClose").addEventListener("click", close);
  form.addEventListener("input", () => { render(); scheduleSave(); });
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    render({ reportErrors: true });
    scheduleSave({ immediate: true });
  });
  byId("silverTargetReset").addEventListener("click", () => {
    clearTimeout(saveTimer);
    form.reset();
    fields.tolerancePercent.value = String(DEFAULT_TOLERANCE_PERCENT);
    clearLegacyInputs();
    render();
    if (cloudReady) {
      const emptyFingerprint = settingsFingerprint({});
      enqueueSync(() => apiFetch("/api/silver-target-settings", { method: "DELETE" }), emptyFingerprint);
    } else {
      setSyncState("offline", "云端未连接 · 点击重试");
    }
    fields.xagAnchor.focus();
  });
  resultNodes.sync.addEventListener("click", async () => {
    if (!cloudReady) await connect();
    else flushSave();
  });
  overlay.addEventListener("click", (event) => {
    if (event.target === overlay) close();
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && !overlay.hidden) {
      event.preventDefault();
      close();
    }
  });

  return { open, close, render, connect, disconnect, flushSave };
}
