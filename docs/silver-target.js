const DEFAULT_TOLERANCE_PERCENT = 0.5;
const MAX_TOLERANCE_PERCENT = 10;

function positiveNumber(value, label) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) throw new Error(`${label}必须大于 0`);
  return number;
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

const numberFormat = new Intl.NumberFormat("zh-CN", { maximumFractionDigits: 0 });
const ratioFormat = new Intl.NumberFormat("zh-CN", { minimumFractionDigits: 2, maximumFractionDigits: 4 });
const STORAGE_KEY = "tradeReviewSilverTargetV1";

function formatSignedPercent(value) {
  const sign = value > 0 ? "+" : "";
  return `${sign}${(value * 100).toFixed(2)}%`;
}

function formatSignedPoints(value) {
  const rounded = Math.round(value);
  return `${rounded > 0 ? "+" : ""}${numberFormat.format(rounded)} 点`;
}

function readSavedInputs() {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY) || "null") || {};
  } catch {
    return {};
  }
}

function saveInputs(values) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(values));
  } catch {
    // The calculator remains usable when storage is unavailable.
  }
}

export function initSilverTargetCalculator(root = document) {
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
  };

  function currentValues() {
    return Object.fromEntries(Object.entries(fields).map(([key, field]) => [key, field?.value ?? ""]));
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
    saveInputs(values);
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

  function open() {
    overlay.hidden = false;
    document.body.classList.add("silver-target-open");
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

  const saved = readSavedInputs();
  Object.entries(fields).forEach(([key, field]) => {
    if (saved[key] !== undefined) field.value = saved[key];
  });
  if (!fields.tolerancePercent.value) fields.tolerancePercent.value = String(DEFAULT_TOLERANCE_PERCENT);
  render();

  trigger.addEventListener("click", open);
  byId("silverTargetClose").addEventListener("click", close);
  form.addEventListener("input", () => render());
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    render({ reportErrors: true });
  });
  byId("silverTargetReset").addEventListener("click", () => {
    form.reset();
    fields.tolerancePercent.value = String(DEFAULT_TOLERANCE_PERCENT);
    try { localStorage.removeItem(STORAGE_KEY); } catch {}
    render();
    fields.xagAnchor.focus();
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

  return { open, close, render };
}
