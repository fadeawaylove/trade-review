export function calculateTradeStats(trades) {
  const wins = trades.filter((trade) => Number(trade.netPnl || 0) > 0);
  const losses = trades.filter((trade) => Number(trade.netPnl || 0) < 0);
  const sum = (rows, key) => rows.reduce((total, row) => total + Number(row[key] || 0), 0);
  const totalProfit = sum(wins, "netPnl");
  const totalLoss = Math.abs(sum(losses, "netPnl"));
  let cumulative = 0;
  let high = 0;
  let maxDrawdown = 0;

  trades.forEach((trade) => {
    cumulative += Number(trade.netPnl || 0);
    high = Math.max(high, cumulative, 0);
    maxDrawdown = Math.min(maxDrawdown, cumulative - high);
  });

  const net = sum(trades, "netPnl");
  const gross = sum(trades, "grossPnl");
  const fees = sum(trades, "fees");
  const avgWin = wins.length ? totalProfit / wins.length : 0;
  const avgLoss = losses.length ? totalLoss / losses.length : 0;

  return {
    count: trades.length,
    wins: wins.length,
    losses: losses.length,
    net,
    gross,
    fees,
    totalProfit,
    totalLoss,
    winRate: trades.length ? wins.length / trades.length : 0,
    payoff: avgLoss ? avgWin / avgLoss : null,
    factor: totalLoss ? totalProfit / totalLoss : null,
    expectancy: trades.length ? net / trades.length : 0,
    maxDrawdown,
    avgWin,
    avgLoss,
  };
}
