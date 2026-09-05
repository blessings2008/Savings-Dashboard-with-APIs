// Deterministic PocketVault insights built from the authenticated user's
// summarized context. These do not call an AI provider, so they remain
// reliable, cheap, and available even when the AI provider is unavailable.
import { buildUserContext, getUserAILimits } from './user-ai.js';

const money = value => `MWK ${Math.round(Number(value || 0)).toLocaleString()}`;

function insight(id, title, text, severity = 'info') {
  return { id, title, text, severity };
}

export async function buildUserInsights(uid, plan) {
  const context = await buildUserContext(uid, plan);
  const limits = getUserAILimits(plan);
  const activity = context.activity || {};
  const savings = context.savings || {};
  const account = context.account || {};
  const autosave = context.autosave || {};
  const insights = [];

  const incoming = Number(activity.incomingMWK || 0);
  const outgoing = Number(activity.outgoingMWK || 0);
  const saved = Number(activity.savingsMWK || savings.recentSavingsMWK || 0);
  const balance = Number(account.pocketVaultBalanceMWK || 0);

  if (activity.count === 0) {
    insights.push(insight('no-activity', 'Start with your first move', 'There is not enough recent activity to spot a money pattern yet. Once you save or make transactions, PocketVault can start showing useful trends.'));
  } else if (incoming > 0 && saved > 0) {
    const rate = Math.round((saved / incoming) * 1000) / 10;
    insights.push(insight('savings-rate', 'Your recent saving rate', `You saved about ${money(saved)} from ${money(incoming)} of incoming activity in the available history — roughly ${rate}%.`, rate >= 20 ? 'positive' : 'info'));
  }

  if (outgoing > incoming && incoming > 0) {
    insights.push(insight('outflow-watch', 'Outgoing activity is higher', `Recent outgoing activity is ${money(outgoing)}, compared with ${money(incoming)} incoming. Keep an eye on withdrawals and payments so your balance does not get squeezed.`, 'warning'));
  }

  if (savings.active === 0 && context.goals?.length === 0) {
    insights.push(insight('goal-opportunity', 'Give your savings a target', 'You do not have a savings goal yet. A specific target can make saving easier to track and gives PocketVault something concrete to measure.'));
  } else if (savings.activeGoalCount > 0 && savings.activeProgressPercent < 25) {
    insights.push(insight('goal-start', 'Your goals are still early', `${savings.activeGoalCount} active goal${savings.activeGoalCount === 1 ? '' : 's'} are at ${savings.activeProgressPercent}% combined progress. A small, repeatable contribution may be easier to maintain than waiting for a large amount.`, 'info'));
  } else if (savings.activeGoalCount > 0 && savings.activeProgressPercent >= 75) {
    insights.push(insight('goal-near', 'You are close on your goals', `Your active goals are ${savings.activeProgressPercent}% funded overall. You have ${money(Math.max(0, savings.activeTargetMWK - savings.activeSavedMWK))} left across active targets.`, 'positive'));
  }

  if (activity.failedCount > 0) {
    insights.push(insight('failed-transactions', 'Some transactions need attention', `${activity.failedCount} recent transaction${activity.failedCount === 1 ? '' : 's'} failed. Check the transaction history for the affected entries before trying again.`, 'warning'));
  }

  if (activity.pendingCount > 0) {
    insights.push(insight('pending-transactions', 'You have pending activity', `${activity.pendingCount} transaction${activity.pendingCount === 1 ? '' : 's'} are still pending. Avoid assuming the money movement is complete until the status changes.`, 'warning'));
  }

  if (autosave.enabledRuleCount === 0 && limits.insights) {
    insights.push(insight('autosave', 'Auto-Save is not active', 'You currently have no enabled Auto-Save rules. If your income is regular, an automatic rule could make saving more consistent.'));
  }

  if (balance > 0 && savings.activeGoalCount > 0) {
    const remainingToGoals = Math.max(0, savings.activeTargetMWK - savings.activeSavedMWK);
    if (remainingToGoals > 0 && balance >= remainingToGoals) {
      insights.push(insight('goal-affordability', 'Your balance could cover your remaining goal targets', `Your current PocketVault balance is ${money(balance)}, while the remaining amount across active goals is ${money(remainingToGoals)}. That does not mean you should allocate it all — keep enough available for your needs.`, 'positive'));
    }
  }

  const max = plan === 'business' ? 5 : plan === 'pro' ? 4 : 2;
  return {
    plan,
    generatedAt: new Date().toISOString(),
    historyDays: limits.historyDays,
    insights: insights.slice(0, max)
  };
}
