const DEFAULT_WIDTH = 900;
const DEFAULT_HEIGHT = 280;
const DEFAULT_PAD = Object.freeze({ l: 55, r: 24, t: 24, b: 36 });

export function buildEquityChartModel(trades, options = {}) {
  const width = options.width || DEFAULT_WIDTH;
  const height = options.height || DEFAULT_HEIGHT;
  const pad = { ...DEFAULT_PAD, ...(options.pad || {}) };
  let cumulative = 0;
  const values = trades.map((trade) => {
    const pnl = Number(trade.netPnl) || 0;
    cumulative += pnl;
    return {
      id: trade.tradeId,
      date: trade.dateLabel || trade.date || "日期待确认",
      summary: `${trade.instrument || "未知品种"} · ${trade.direction || "未知方向"}单`,
      pnl,
      value: cumulative,
    };
  });

  if (!values.length) {
    return { width, height, pad, values, points: [], hitBounds: [], ticks: [], line: "", area: "", base: 0 };
  }

  const min = Math.min(0, ...values.map((point) => point.value));
  const max = Math.max(0, ...values.map((point) => point.value));
  const span = Math.max(1, max - min);
  const plotLeft = pad.l;
  const plotRight = width - pad.r;
  const x = values.length === 1
    ? () => (plotLeft + plotRight) / 2
    : (index) => plotLeft + index / (values.length - 1) * (plotRight - plotLeft);
  const y = (value) => pad.t + (max - value) / span * (height - pad.t - pad.b);
  const points = values.map((point, index) => [x(index), y(point.value)]);
  const line = points.map((point, index) => `${index ? "L" : "M"}${point[0].toFixed(1)},${point[1].toFixed(1)}`).join(" ");
  const base = y(0);
  const area = `${line} L${points.at(-1)[0]},${base} L${points[0][0]},${base} Z`;
  const ticks = [0, .25, .5, .75, 1].map((ratio) => max - span * ratio);
  const hitBounds = points.map((point, index) => ({
    start: index === 0 ? plotLeft : (points[index - 1][0] + point[0]) / 2,
    end: index === points.length - 1 ? plotRight : (point[0] + points[index + 1][0]) / 2,
  }));

  return { width, height, pad, values, points, hitBounds, ticks, line, area, base };
}

export function tooltipPlacement([x, y], width, height) {
  return {
    horizontal: x > width * .68 ? "left" : "right",
    vertical: y > height * .5 ? "above" : "below",
  };
}
