const DEFAULT_WIDTH = 900;
const DEFAULT_HEIGHT = 280;
const DEFAULT_PAD = Object.freeze({ l: 55, r: 24, t: 24, b: 36 });

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
  const values = groupedTrades.map((group) => {
    const open = cumulative;
    let high = open;
    let low = open;
    let dayPnl = 0;

    group.trades.forEach(({ trade }) => {
      const pnl = Number(trade.netPnl) || 0;
      dayPnl += pnl;
      cumulative += pnl;
      high = Math.max(high, cumulative);
      low = Math.min(low, cumulative);
    });

    const tradeIds = group.trades.map(({ trade }) => trade.tradeId);
    const lastTrade = group.trades.at(-1);
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
      pnl: dayPnl,
      value: cumulative,
    };
  });

  if (!values.length) {
    return { width, height, pad, values, points: [], candles: [], hitBounds: [], ticks: [], base: 0 };
  }

  const observedMin = Math.min(0, ...values.map((day) => day.low));
  const observedMax = Math.max(0, ...values.map((day) => day.high));
  const observedSpan = Math.max(1, observedMax - observedMin);
  const domainMin = observedMin - observedSpan * .08;
  const domainMax = observedMax + observedSpan * .08;
  const span = domainMax - domainMin;
  const plotLeft = pad.l;
  const plotRight = width - pad.r;
  const x = values.length === 1
    ? () => (plotLeft + plotRight) / 2
    : (index) => plotLeft + index / (values.length - 1) * (plotRight - plotLeft);
  const y = (value) => pad.t + (domainMax - value) / span * (height - pad.t - pad.b);
  const points = values.map((day, index) => [x(index), y(day.close)]);
  const slotWidth = (plotRight - plotLeft) / Math.max(1, values.length);
  const bodyWidth = Math.min(28, Math.max(9, slotWidth * .36));
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
  const hitBounds = points.map((point, index) => ({
    start: index === 0 ? plotLeft : (points[index - 1][0] + point[0]) / 2,
    end: index === points.length - 1 ? plotRight : (point[0] + points[index + 1][0]) / 2,
  }));

  return { width, height, pad, values, points, candles, hitBounds, ticks, base };
}

export function tooltipPlacement([x, y], width, height) {
  return {
    horizontal: x > width * .68 ? "left" : "right",
    vertical: y > height * .5 ? "above" : "below",
  };
}
