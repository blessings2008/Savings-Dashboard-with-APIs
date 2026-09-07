// Deterministic financial metrics used to ground PocketVault AI answers.
// This module performs calculations only; it never calls an AI provider.

function asNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function dateValue(value) {
  if (!value) return null;
  const date = value?.toDate ? value.toDate() : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function amountOf(t) {
  return Math.abs(asNumber(t.amount ?? t.value ?? t.amountMWK));
}

function directionOf(t) {
  const direction = String(t.direction || '').toLowerCase();
  if (['in', 'incoming', 'credit'].includes(direction)) return 'in';
  if (['out', 'outgoing', 'debit'].includes(direction)) return 'out';
  const type = String(t.type || '').toLowerCase();
  if (['deposit', 'save', 'add_funds', 'add-funds', 'collection', 'merchant_collect', 'transfer_in', 'credit'].includes(type)) return 'in';
  if (['withdraw', 'payment', 'merchant_payment', 'merchant-pay', 'transfer', 'transfer_out', 'subscription', 'disbursement', 'debit'].includes(type)) return 'out';
  return 'unknown';
}

const isSavings = t => ['save', 'savings', 'goal_allocation'].includes(String(t.type || '').toLowerCase());

function windowSummary(transactions, days, now = Date.now()) {
  const cutoff = now - days * 24 * 60 * 60 * 1000;
  const rows = transactions.filter(t => {
    const d = dateValue(t.timestamp);
    return d && d.getTime() >= cutoff;
  });
  let incoming = 0, outgoing = 0, savings = 0;
  for (const t of rows) {
    const amount = amountOf(t), direction = directionOf(t);
    if (direction === 'in') incoming += amount;
    if (direction === 'out') outgoing += amount;
    if (isSavings(t)) savings += amount;
  }
  const net = incoming - outgoing;
  return {
    days,
    transactionCount: rows.length,
    incomingMWK: incoming,
    outgoingMWK: outgoing,
    savingsMWK: savings,
    netMWK: net,
    savingsRatePercent: incoming > 0 ? Math.round((savings / incoming) * 1000) / 10 : null,
    outflowRatePercent: incoming > 0 ? Math.round((outgoing / incoming) * 1000) / 10 : null
  };
}

export function buildFinancialMetrics(transactions, now = Date.now()) {
  const windows = {
    last7Days: windowSummary(transactions, 7, now),
    last30Days: windowSummary(transactions, 30, now),
    last90Days: windowSummary(transactions, 90, now)
  };

  const byType = {};
  const failedTypes = {};
  let largestOutflow = null;
  for (const t of transactions) {
    const type = String(t.type || 'unknown').toLowerCase();
    const amount = amountOf(t);
    byType[type] = (byType[type] || 0) + amount;
    const status = String(t.status || '').toLowerCase();
    if (['failed', 'failure', 'rejected'].includes(status)) failedTypes[type] = (failedTypes[type] || 0) + 1;
    if (directionOf(t) === 'out' && (!largestOutflow || amount > largestOutflow.amountMWK)) {
      largestOutflow = { amountMWK: amount, type, timestamp: t.timestamp };
    }
  }

  const topTypes = Object.entries(byType)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([type, amountMWK]) => ({ type, amountMWK }));

  const seven = windows.last7Days;
  const thirty = windows.last30Days;
  const weeklyEquivalent30 = thirty.outgoingMWK / 30 * 7;
  const spendingTrendPercent = weeklyEquivalent30 > 0 ? Math.round(((seven.outgoingMWK - weeklyEquivalent30) / weeklyEquivalent30) * 1000) / 10 : null;

  return {
    windows,
    spendingTrend: { sevenDayVs30DayWeeklyEquivalentPercent: spendingTrendPercent },
    topTransactionTypesByAmount: topTypes,
    failedTransactionTypes: failedTypes,
    largestOutflow: largestOutflow ? { ...largestOutflow, timestamp: dateValue(largestOutflow.timestamp)?.toISOString() || null } : null
  };
}

export function buildGoalMetrics(goals, transactions, now = Date.now()) {
  const savings30 = windowSummary(transactions, 30, now).savingsMWK;
  const monthlyVelocity = savings30;
  return goals.map(goal => {
    const remainingMWK = Math.max(0, goal.targetMWK - goal.savedMWK);
    const progressPercent = goal.targetMWK > 0 ? Math.round((goal.savedMWK / goal.targetMWK) * 1000) / 10 : 0;
    const estimatedMonths = monthlyVelocity > 0 && remainingMWK > 0 ? Math.ceil(remainingMWK / monthlyVelocity) : null;
    return {
      name: goal.name,
      progressPercent,
      remainingMWK,
      monthlySavingsVelocityMWK: monthlyVelocity,
      estimatedMonthsAtCurrentVelocity: estimatedMonths,
      deadline: goal.deadline,
      completed: goal.completed,
      frozen: goal.frozen
    };
  });
}
