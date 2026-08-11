const DEFAULT_WIDTH = 900;
const DEFAULT_HEIGHT = 280;
const DEFAULT_PAD = Object.freeze({ l: 18, r: 94, t: 54, b: 42 });
const MIN_SPARSE_SLOTS = 7;
const roundMoney = (value) => Math.round((value + Number.EPSILON) * 100) / 100;

export function resolveChartRange(mode, compact = false) {
  if (mode === "all") return Infinity;
  return compact ? 15 : 30;
}

export function resolveEquityWheelCount({ currentVisibleCount, totalDays, deltaY, minimumVisibleCount = 6 }) {
  const total = Math.max(0, Math.floor(Number(totalDays) || 0));
  if (!total) return 0;
  const current = Math.max(1, Math.min(total, Math.round(Number(currentVisibleCount) || total)));
  const minimum = Math.min(total, Math.max(1, Math.floor(Number(minimumVisibleCount) || 1)));
  const step = Math.max(1, Math.round(current * .08));
  return Math.max(minimum, Math.min(total, current + (Number(deltaY) < 0 ? -step : step)));
}

export function resolveEquityPointerRatio({ clientX, boundsLeft, boundsWidth, chartWidth, padLeft, padRight }) {
  const scale = Math.max(1, Number(boundsWidth) || 0) / Math.max(1, Number(chartWidth) || 0);
  const plotLeft = Number(boundsLeft) + (Number(padLeft) || 0) * scale;
  const plotWidth = Math.max(1, (Number(chartWidth) - (Number(padLeft) || 0) - (Number(padRight) || 0)) * scale);
  return Math.max(0, Math.min(1, (Number(clientX) - plotLeft) / plotWidth));
}

export function resolveEquityPanWindow({ totalDays, visibleStart, visibleEnd, deltaPixels, plotWidth }) {
  const total = Math.max(0, Math.floor(Number(totalDays) || 0));
  const start = Math.max(0, Math.min(total, Math.floor(Number(visibleStart) || 0)));
  const end = Math.max(start, Math.min(total, Math.floor(Number(visibleEnd) || total)));
  const count = Math.max(1, end - start);
  const slotWidth = Math.max(1, Number(plotWidth) || 0) / count;
  const requestedShift = -Math.round((Number(deltaPixels) || 0) / slotWidth);
  const nextEnd = Math.max(count, Math.min(total, end + requestedShift));
  return { dayShift: nextEnd - end, windowEnd: nextEnd };
}

export function resolveEquityPanOffset({ currentOffset = 0, deltaPixels = 0, plotWidth, maximumFraction = .35 }) {
  const width = Math.max(1, Number(plotWidth) || 0);
  const limit = width * Math.max(0, Math.min(.5, Number(maximumFraction) || 0));
  return Math.max(-limit, Math.min(limit, (Number(currentOffset) || 0) + (Number(deltaPixels) || 0)));
}

export function scaleEquityPriceDomain({ min, max, deltaPixels, plotHeight }) {
  const domainMin = Number(min) || 0;
  const domainMax = Number(max) || 0;
  const center = (domainMin + domainMax) / 2;
  const span = Math.max(.01, domainMax - domainMin);
  const factor = Math.max(.1, Math.min(10, 1 + (Number(deltaPixels) || 0) / Math.max(1, Number(plotHeight) || 0)));
  const nextSpan = span * factor;
  return { min: roundMoney(center - nextSpan / 2), max: roundMoney(center + nextSpan / 2) };
}

export function resolveEquityZoomWindow({
  totalDays,
  visibleStart,
  visibleEnd,
  nextVisibleCount,
  anchorRatio = .5,
  minimumVisibleCount = 6,
}) {
  const total = Math.max(0, Math.floor(Number(totalDays) || 0));
  if (!total) return { visibleCount: 0, windowEnd: 0 };
  const ratio = Math.max(0, Math.min(1, Number(anchorRatio) || 0));
  const currentStart = Math.max(0, Math.min(total - 1, Math.floor(Number(visibleStart) || 0)));
  const currentEnd = Math.max(currentStart + 1, Math.min(total, Math.floor(Number(visibleEnd) || total)));
  const currentCount = currentEnd - currentStart;
  const minimum = Math.min(total, Math.max(1, Math.floor(Number(minimumVisibleCount) || 1)));
  const visibleCount = Math.max(minimum, Math.min(total, Math.round(Number(nextVisibleCount) || currentCount)));
  const anchorIndex = currentStart + ratio * Math.max(0, currentCount - 1);
  const maximumStart = Math.max(0, total - visibleCount);
  const nextStart = Math.max(0, Math.min(maximumStart, Math.round(anchorIndex - ratio * Math.max(0, visibleCount - 1))));
  return { visibleCount, windowEnd: nextStart + visibleCount };
}

export function chartWidthForRange(totalDays, mode, baseWidth = DEFAULT_WIDTH) {
  return baseWidth;
}

function normalizedDateParts(value) {
  const text = String(value || "").trim();
  const match = text.match(/^(\d{4})[/-](\d{1,2})[/-](\d{1,2})$/)
    || text.match(/^(\d{4})年(\d{1,2})月(\d{1,2})日$/);
  if (!match) return null;
  return [match[1], match[2].padStart(2, "0"), match[3].padStart(2, "0")];
}

function normalizeDateKey(value) {
  const parts = normalizedDateParts(value);
  return parts ? parts.join("-") : String(value || "").trim();
}

export function formatEquityDateLabel(value) {
  const parts = normalizedDateParts(value);
  return parts ? `${parts[1]}-${parts[2]}` : String(value || "").replace(/^\d{4}[/-]/, "");
}

export function formatEquityAxisValue(value) {
  const numeric = Number(value) || 0;
  const sign = numeric < 0 ? "-" : "";
  const absolute = Math.abs(numeric);
  return `${sign}¥${absolute.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function monthKey(value) {
  const parts = normalizedDateParts(value);
  return parts ? `${parts[0]}-${parts[1]}` : "";
}

function buildLabelIndices(values, slotWidth) {
  if (!values.length) return [];
  const step = Math.max(1, Math.ceil(72 / Math.max(1, slotWidth)));
  const required = new Set([0, values.length - 1]);
  for (let index = 1; index < values.length; index += 1) {
    const currentMonth = monthKey(values[index].dateKey || values[index].date);
    if (currentMonth && currentMonth !== monthKey(values[index - 1].dateKey || values[index - 1].date)) required.add(index);
  }
  const indices = new Set(required);
  for (let index = 0; index < values.length; index += step) {
    if ([...required].every((requiredIndex) => Math.abs(requiredIndex - index) >= step)) indices.add(index);
  }
  return [...indices].sort((a, b) => a - b);
}

function niceTickStep(span, targetIntervals = 4) {
  const rough = Math.max(1, span / targetIntervals);
  const magnitude = 10 ** Math.floor(Math.log10(rough));
  const normalized = rough / magnitude;
  const factor = normalized <= 1 ? 1 : normalized <= 2 ? 2 : normalized <= 2.5 ? 2.5 : normalized <= 5 ? 5 : 10;
  return factor * magnitude;
}

function tradeOrderValue(trade, fallbackIndex) {
  const match = String(trade.exitTime || trade.entryTime || "").match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?/);
  if (!match) return fallbackIndex;
  const hour = Number(match[1]);
  const shiftedHour = hour < 18 ? hour + 24 : hour;
  return shiftedHour * 3600 + Number(match[2]) * 60 + Number(match[3] || 0);
}

export function buildEquityChartModel(trades, options = {}) {
  const width = options.width || DEFAULT_WIDTH;
  const height = options.height || DEFAULT_HEIGHT;
  const pad = { ...DEFAULT_PAD, ...(options.pad || {}) };
  const groupedTrades = [];
  const dayByDate = new Map();

  trades.forEach((trade, tradeIndex) => {
    const date = trade.dateLabel || trade.date || "日期待确认";
    const dateKey = normalizeDateKey(date);
    if (!dayByDate.has(dateKey)) {
      const day = { date, dateKey, displayDate: formatEquityDateLabel(dateKey), trades: [] };
      dayByDate.set(dateKey, day);
      groupedTrades.push(day);
    }
    dayByDate.get(dateKey).trades.push({ trade, tradeIndex });
  });

  let cumulative = 0;
  const allValues = groupedTrades.map((group) => {
    const orderedTrades = [...group.trades].sort((a, b) => {
      const difference = tradeOrderValue(a.trade, a.tradeIndex) - tradeOrderValue(b.trade, b.tradeIndex);
      return difference || a.tradeIndex - b.tradeIndex;
    });
    const open = cumulative;
    let dayPnl = 0;
    let high = open;
    let low = open;
    const pnlPath = [open];

    orderedTrades.forEach(({ trade }) => {
      const pnl = Number(trade.netPnl) || 0;
      dayPnl = roundMoney(dayPnl + pnl);
      cumulative = roundMoney(cumulative + pnl);
      pnlPath.push(cumulative);
      high = Math.max(high, cumulative);
      low = Math.min(low, cumulative);
    });

    const tradeIds = orderedTrades.map(({ trade }) => trade.tradeId);
    const lastTrade = orderedTrades.at(-1);
    return {
      id: group.dateKey,
      date: group.date,
      dateKey: group.dateKey,
      displayDate: group.displayDate,
      summary: `${group.trades.length} 笔完整交易`,
      open,
      high,
      low,
      close: cumulative,
      dayPnl,
      tradeCount: group.trades.length,
      tradeIds,
      lastTradeId: lastTrade?.trade.tradeId || null,
      lastTradeIndex: lastTrade?.tradeIndex ?? -1,
      pnlPath,
      pnl: dayPnl,
      value: cumulative,
    };
  });

  if (!allValues.length) {
    return {
      width, height, pad, values: [], points: [], candles: [], hitBounds: [], ticks: [], tickYs: [], labelIndices: [], base: 0,
      totalDays: 0, visibleStart: 0, visibleEnd: 0, canMoveEarlier: false, canMoveLater: false, layoutSlotCount: MIN_SPARSE_SLOTS,
    };
  }

  const requestedCount = Number.isFinite(options.visibleCount)
    ? Math.max(1, Math.floor(options.visibleCount))
    : allValues.length;
  const visibleCount = Math.min(requestedCount, allValues.length);
  const requestedEnd = Number.isFinite(options.windowEnd) ? Math.floor(options.windowEnd) : allValues.length;
  const visibleEnd = visibleCount >= allValues.length
    ? allValues.length
    : Math.max(visibleCount, Math.min(allValues.length, requestedEnd));
  const visibleStart = Math.max(0, visibleEnd - visibleCount);
  const values = allValues.slice(visibleStart, visibleEnd);

  const observedMin = Math.min(0, ...values.flatMap((day) => [day.open, day.high, day.low, day.close]));
  const observedMax = Math.max(0, ...values.flatMap((day) => [day.open, day.high, day.low, day.close]));
  const observedSpan = Math.max(1, observedMax - observedMin);
  const autoTickStep = niceTickStep(observedSpan, 8);
  const autoDomainMin = Math.floor(observedMin / autoTickStep) * autoTickStep - autoTickStep;
  const autoDomainMax = Math.ceil(observedMax / autoTickStep) * autoTickStep;
  const requestedDomain = options.domain;
  const usesRequestedDomain = Number.isFinite(requestedDomain?.min)
    && Number.isFinite(requestedDomain?.max)
    && requestedDomain.max > requestedDomain.min;
  const domainMin = usesRequestedDomain ? requestedDomain.min : autoDomainMin;
  const domainMax = usesRequestedDomain ? requestedDomain.max : autoDomainMax;
  const span = domainMax - domainMin;
  const tickStep = niceTickStep(span, 10);
  const plotLeft = pad.l;
  const plotRight = width - pad.r;
  const layoutSlotCount = Math.max(MIN_SPARSE_SLOTS, values.length);
  const slotWidth = (plotRight - plotLeft) / layoutSlotCount;
  const leadingSlots = (layoutSlotCount - values.length) / 2;
  const x = (index) => plotLeft + (leadingSlots + index + .5) * slotWidth;
  const y = (value) => pad.t + (domainMax - value) / span * (height - pad.t - pad.b);
  const points = values.map((day, index) => [x(index), y(day.close)]);
  const bodyWidth = Math.min(38, Math.max(7, slotWidth * .55));
  const candles = values.map((day, index) => {
    const openY = y(day.open);
    const closeY = y(day.close);
    return {
      x: x(index),
      openY,
      highY: y(day.high),
      lowY: y(day.low),
      closeY,
      bodyY: Math.min(openY, closeY),
      bodyHeight: Math.max(2.4, Math.abs(closeY - openY)),
      bodyWidth,
    };
  });
  const base = y(0);
  const tickTop = Math.floor(domainMax / tickStep) * tickStep;
  const tickBottom = Math.ceil(domainMin / tickStep) * tickStep;
  const tickIntervals = Math.max(0, Math.floor((tickTop - tickBottom) / tickStep));
  const ticks = Array.from({ length: tickIntervals + 1 }, (_, index) => roundMoney(tickTop - tickStep * index));
  const tickYs = ticks.map(y);
  const hitBounds = points.map((point) => ({ start: point[0] - slotWidth / 2, end: point[0] + slotWidth / 2 }));
  const labelIndices = buildLabelIndices(values, slotWidth);

  return {
    width, height, pad, values, points, candles, hitBounds, ticks, tickYs, labelIndices, base, slotWidth, layoutSlotCount, domainMin, domainMax,
    totalDays: allValues.length,
    visibleStart,
    visibleEnd,
    canMoveEarlier: visibleStart > 0,
    canMoveLater: visibleEnd < allValues.length,
  };
}
