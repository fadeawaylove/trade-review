const DEFAULT_WIDTH = 900;
const DEFAULT_HEIGHT = 280;
const DEFAULT_PAD = Object.freeze({ l: 55, r: 24, t: 24, b: 36 });
const MIN_SPARSE_SLOTS = 7;
const MIN_ALL_SLOT_WIDTH = 26;
const roundMoney = (value) => Math.round((value + Number.EPSILON) * 100) / 100;

export function resolveChartRange(mode, compact = false) {
  if (mode === "all") return Infinity;
  if (mode === "long") return compact ? 30 : 60;
  return compact ? 15 : 30;
}

export function chartWidthForRange(totalDays, mode, baseWidth = DEFAULT_WIDTH) {
  if (mode !== "all") return baseWidth;
  return Math.max(baseWidth, DEFAULT_PAD.l + DEFAULT_PAD.r + Math.max(MIN_SPARSE_SLOTS, totalDays) * MIN_ALL_SLOT_WIDTH);
}

function monthKey(value) {
  const match = String(value || "").replaceAll("/", "-").match(/^(\d{4})-(\d{2})/);
  return match ? `${match[1]}-${match[2]}` : "";
}

function buildLabelIndices(values, slotWidth) {
  if (!values.length) return [];
  const step = Math.max(1, Math.ceil(66 / Math.max(1, slotWidth)));
  const indices = new Set([0, values.length - 1]);
  for (let index = 0; index < values.length; index += step) indices.add(index);
  for (let index = 1; index < values.length; index += 1) {
    const currentMonth = monthKey(values[index].date);
    if (currentMonth && currentMonth !== monthKey(values[index - 1].date)) indices.add(index);
  }
  return [...indices].sort((a, b) => a - b);
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
    if (!dayByDate.has(date)) {
      const day = { date, trades: [] };
      dayByDate.set(date, day);
      groupedTrades.push(day);
    }
    dayByDate.get(date).trades.push({ trade, tradeIndex });
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
      id: group.date,
      date: group.date,
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
      width, height, pad, values: [], points: [], candles: [], hitBounds: [], ticks: [], labelIndices: [], base: 0,
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
  const domainMin = observedMin - observedSpan * .08;
  const domainMax = observedMax + observedSpan * .08;
  const span = domainMax - domainMin;
  const plotLeft = pad.l;
  const plotRight = width - pad.r;
  const layoutSlotCount = Math.max(MIN_SPARSE_SLOTS, values.length);
  const slotWidth = (plotRight - plotLeft) / layoutSlotCount;
  const leadingSlots = (layoutSlotCount - values.length) / 2;
  const x = (index) => plotLeft + (leadingSlots + index + .5) * slotWidth;
  const y = (value) => pad.t + (domainMax - value) / span * (height - pad.t - pad.b);
  const points = values.map((day, index) => [x(index), y(day.close)]);
  const bodyWidth = Math.min(28, Math.max(6, slotWidth * .42));
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
  const ticks = [0, .25, .5, .75, 1].map((ratio) => domainMax - span * ratio);
  const hitBounds = points.map((point) => ({ start: point[0] - slotWidth / 2, end: point[0] + slotWidth / 2 }));
  const labelIndices = buildLabelIndices(values, slotWidth);

  return {
    width, height, pad, values, points, candles, hitBounds, ticks, labelIndices, base, slotWidth, layoutSlotCount,
    totalDays: allValues.length,
    visibleStart,
    visibleEnd,
    canMoveEarlier: visibleStart > 0,
    canMoveLater: visibleEnd < allValues.length,
  };
}
