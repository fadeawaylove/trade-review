export function resolveTradeNavigation(trades, tradeId) {
  const rows = Array.isArray(trades) ? trades : [];
  const index = rows.findIndex((trade) => trade.tradeId === tradeId);
  return {
    previous: index > 0 ? rows[index - 1] : null,
    next: index >= 0 && index < rows.length - 1 ? rows[index + 1] : null,
  };
}
