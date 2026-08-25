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

function normalizeContract(value) {
  const contract = String(value ?? "").trim().toUpperCase();
  if (contract && !/^AG\d{4}$/.test(contract)) throw new Error("AG 合约必须为 AG 加四位数字，例如 AG2612");
  return contract;
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
  const contract = normalizeContract(source.contract);
  const mode = source.mode === undefined || source.mode === null || source.mode === ""
    ? (contract ? "manual" : "auto")
    : String(source.mode);
  if (!["auto", "manual"].includes(mode)) throw new Error("合约模式必须为自动主力或指定合约");
  if (mode === "manual" && !contract) throw new Error("指定合约必须为 AG 加四位数字，例如 AG2612");
  const tolerancePercent = source.tolerancePercent === "" || source.tolerancePercent === null || source.tolerancePercent === undefined
    ? DEFAULT_TOLERANCE_PERCENT
    : Number(source.tolerancePercent);
  if (!Number.isFinite(tolerancePercent) || tolerancePercent < 0 || tolerancePercent > MAX_TOLERANCE_PERCENT) {
    throw new Error(`映射容差必须在 0–${MAX_TOLERANCE_PERCENT}% 之间`);
  }
  return {
    mode,
    contract,
    xagAnchor: optionalPositiveNumber(source.xagAnchor, "XAGUSD 锚点"),
    agAnchor: optionalPositiveNumber(source.agAnchor, "AG 锚点"),
    xagTarget: optionalPositiveNumber(source.xagTarget, "XAGUSD 目标价"),
    tolerancePercent,
  };
}

export function normalizeContractSelection(value, settings = {}) {
  const source = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  const normalizedSettings = normalizeSilverSettings(settings);
  const safeContract = (contract) => {
    try { return normalizeContract(contract); } catch { return ""; }
  };
  const mode = source.mode === "manual" || source.mode === "auto" ? source.mode : normalizedSettings.mode;
  const autoContract = safeContract(source.autoContract);
  const manualContract = safeContract(source.manualContract) || normalizedSettings.contract;
  const suppliedEffective = safeContract(source.effectiveContract);
  const effectiveContract = mode === "auto"
    ? (autoContract || suppliedEffective)
    : (manualContract || suppliedEffective);
  return {
    mode,
    autoContract,
    manualContract,
    effectiveContract,
    selectedAt: String(source.selectedAt || ""),
    observedAt: String(source.observedAt || ""),
    stale: Boolean(source.stale),
    error: String(source.error || ""),
  };
}

export function resolveSilverAnchor(settings, marketAnchor, effectiveContract = null) {
  const personal = normalizeSilverSettings(settings);
  const market = marketAnchor && typeof marketAnchor === "object" ? marketAnchor : null;
  const contract = normalizeContract(effectiveContract ?? personal.contract);
  if (market && market.contract === contract) {
    try {
      return {
        mode: "market",
        xagAnchor: positiveNumber(market.xagAnchor, "XAGUSD 锚点"),
        agAnchor: positiveNumber(market.agAnchor, "AG 锚点"),
      };
    } catch {}
  }
  return { mode: "manual", xagAnchor: personal.xagAnchor, agAnchor: personal.agAnchor };
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
    contractAuto: byId("silverContractAuto"),
    contractManual: byId("silverContractManual"),
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
    market: byId("silverMarketAnchorState"),
    contractHint: byId("silverContractHint"),
  };
  let cloudReady = false;
  let connectPromise = null;
  let saveTimer = 0;
  let syncChain = Promise.resolve();
  let syncRevision = 0;
  let sessionEpoch = 0;
  let lastFingerprint = "";
  let personalSettings = normalizeSilverSettings({});
  let marketAnchor = null;
  let contractSelection = normalizeContractSelection({}, personalSettings);

  function currentValues() {
    return Object.fromEntries(Object.entries(fields).map(([key, field]) => [key, field?.value ?? ""]));
  }

  function activeMode() {
    return fields.contractManual.checked ? "manual" : "auto";
  }

  function effectiveContract() {
    return contractSelection.effectiveContract;
  }

  function applySettings(value) {
    const settings = normalizeSilverSettings(value);
    personalSettings = settings;
    fields.xagAnchor.value = settings.xagAnchor ?? "";
    fields.agAnchor.value = settings.agAnchor ?? "";
    fields.xagTarget.value = settings.xagTarget ?? "";
    fields.tolerancePercent.value = settings.tolerancePercent;
    return settings;
  }

  function applyContractSelection(value) {
    contractSelection = normalizeContractSelection(value, personalSettings);
    fields.contractAuto.checked = contractSelection.mode === "auto";
    fields.contractManual.checked = contractSelection.mode === "manual";
    fields.contract.readOnly = contractSelection.mode === "auto";
    fields.contract.value = effectiveContract();
    fields.contract.placeholder = contractSelection.mode === "auto" ? "等待自动主力" : "例如 AG2612";
    resultNodes.contractHint.textContent = contractSelection.mode === "auto"
      ? (effectiveContract() ? "当前自动主力合约" : "自动主力尚未选出，等待行情确认")
      : "指定合约需为 AG 加四位数字";
  }

  function renderMarketAnchorState() {
    const resolved = resolveSilverAnchor(personalSettings, marketAnchor, effectiveContract());
    const active = resolved.mode === "market";
    fields.xagAnchor.value = resolved.xagAnchor ?? "";
    fields.agAnchor.value = resolved.agAnchor ?? "";
    fields.xagAnchor.readOnly = active;
    fields.agAnchor.readOnly = active;
    form.dataset.anchorMode = resolved.mode;
    if (contractSelection.mode === "auto" && !effectiveContract()) {
      resultNodes.market.textContent = contractSelection.error || "暂无有效主力，等待自动主力选出";
    } else if (!marketAnchor) {
      resultNodes.market.textContent = contractSelection.mode === "auto"
        ? "自动主力暂无有效行情锚点"
        : "指定合约行情暂不可用，保留个人手工锚点";
    } else if (!active) {
      resultNodes.market.textContent = contractSelection.mode === "auto"
        ? "自动主力暂无有效行情锚点"
        : "指定合约尚无自动快照，可手工填写锚点";
    } else {
      const quoteAt = marketAnchor.xagQuoteAt || marketAnchor.agQuoteAt || marketAnchor.fetchedAt;
      const quoteText = quoteAt ? `报价时间 ${new Date(quoteAt).toLocaleString("zh-CN", { hour12: false })}` : "报价时间未提供";
      resultNodes.market.textContent = `${contractSelection.mode === "auto" ? "自动主力" : "指定合约"} · 新浪免费行情 · ${quoteText}${marketAnchor.stale || contractSelection.stale ? " · 行情陈旧，保留上次成功值" : ""}`;
    }
  }

  function persistenceValues() {
    const values = currentValues();
    return {
      ...values,
      mode: activeMode(),
      contract: activeMode() === "manual" ? values.contract : personalSettings.contract,
      xagAnchor: form.dataset.anchorMode === "market" ? personalSettings.xagAnchor ?? "" : values.xagAnchor,
      agAnchor: form.dataset.anchorMode === "market" ? personalSettings.agAnchor ?? "" : values.agAnchor,
    };
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
    resultNodes.contract.textContent = effectiveContract() || "等待自动主力";
    resultNodes.state.dataset.direction = "flat";
  }

  function render({ reportErrors = false } = {}) {
    const values = currentValues();
    resultNodes.error.hidden = true;
    if (activeMode() === "auto" && !effectiveContract()) {
      clearResult();
      return null;
    }
    const requiredComplete = [values.xagAnchor, values.agAnchor, values.xagTarget].every((value) => String(value).trim());
    if (!requiredComplete) {
      clearResult();
      return null;
    }
    try {
      const result = calculateSilverTarget(values);
      resultNodes.contract.textContent = effectiveContract() || "等待自动主力";
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
    try { settings = normalizeSilverSettings(persistenceValues()); }
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

  async function connect({ refresh = false } = {}) {
    if (cloudReady && !refresh) return true;
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
      applyContractSelection(payload.contractSelection || { mode: settings.mode, manualContract: settings.contract });
      marketAnchor = payload.marketAnchor || null;
      renderMarketAnchorState();
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
    marketAnchor = null;
    personalSettings = normalizeSilverSettings({});
    applyContractSelection({ mode: "auto" });
    fields.tolerancePercent.value = String(DEFAULT_TOLERANCE_PERCENT);
    render();
    setSyncState("offline", "登录后云同步");
  }

  function open() {
    overlay.hidden = false;
    document.body.classList.add("silver-target-open");
    connect({ refresh: true });
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
  applyContractSelection({ mode: personalSettings.mode, manualContract: personalSettings.contract });
  render();
  setSyncState("offline", "登录后云同步");

  trigger.addEventListener("click", open);
  byId("silverTargetClose").addEventListener("click", close);
  form.addEventListener("input", (event) => {
    if (event.target === fields.contractAuto || event.target === fields.contractManual) return;
    const wasMarketAnchor = form.dataset.anchorMode === "market";
    const values = currentValues();
    if (wasMarketAnchor) {
      values.xagAnchor = personalSettings.xagAnchor ?? "";
      values.agAnchor = personalSettings.agAnchor ?? "";
    }
    if (event.target === fields.contract && activeMode() === "manual") {
      contractSelection = normalizeContractSelection({ ...contractSelection, mode: "manual", manualContract: fields.contract.value }, personalSettings);
    }
    try { personalSettings = normalizeSilverSettings({ ...values, mode: activeMode(), contract: activeMode() === "manual" ? values.contract : personalSettings.contract }); } catch {}
    render();
    scheduleSave();
  });
  fields.contractAuto.addEventListener("change", () => {
    if (!fields.contractAuto.checked) return;
    applyContractSelection({ ...contractSelection, mode: "auto" });
    renderMarketAnchorState();
    render();
    scheduleSave({ immediate: true });
  });
  fields.contractManual.addEventListener("change", () => {
    if (!fields.contractManual.checked) return;
    applyContractSelection({ ...contractSelection, mode: "manual", manualContract: personalSettings.contract || contractSelection.manualContract });
    renderMarketAnchorState();
    render();
    scheduleSave({ immediate: true });
    fields.contract.focus();
  });
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    render({ reportErrors: true });
    scheduleSave({ immediate: true });
  });
  byId("silverTargetReset").addEventListener("click", () => {
    clearTimeout(saveTimer);
    form.reset();
    personalSettings = normalizeSilverSettings({});
    marketAnchor = null;
    applyContractSelection({ mode: "auto" });
    fields.tolerancePercent.value = String(DEFAULT_TOLERANCE_PERCENT);
    renderMarketAnchorState();
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
