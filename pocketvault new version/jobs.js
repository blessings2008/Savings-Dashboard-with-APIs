// PocketVault background jobs.
// Every setInterval-scheduled job: transaction reconciliation, float
// monitoring, subscription expiry + goal freeze/grace-period
// handling, goal deadline handling, transaction summary polling
// (auto-save income/round-up triggers), proactive anomaly scanning,
// and auto-save rule execution.
//
// Scheduling itself (the actual setInterval/setTimeout calls) lives
// in server.js, which imports the functions exported here — this
// file only defines what each job DOES, not when it runs.
//
// unfreezeGoalsOnRenewal is also imported directly by
// routes/user.js's /api/subscribe handler, since a renewal needs to
// immediately un-freeze any frozen goals rather than waiting for the
// next scheduled run.
import { db, FieldValue } from './core/firebase.js';
import { SECURITY, FLOAT_THRESHOLD, resolvePaymentProvider, isMockMode } from './core/config.js';
import { cache, clearCache } from './core/state.js';
import { getPlanConfig } from './core/middleware.js';
import {
  airtelBalance, airtelCollect, airtelTransactionStatus, airtelTransactionSummary,
  generateRef, deactivateMerchantCode, calcFee, toMillis, isAirtelSuccess,
  logTransaction, logFee, pushNotification, updateGoalProgress,
  logSystemError, sendExternalAlert, log, AIRTEL_FEE_PERCENT
} from './helpers.js';

// ----------------------------
// RECONCILIATION ENGINE
// ----------------------------
export async function reconcilePendingTransactions() {
  if (isMockMode()) return;
  try {
    console.log('🔄 Reconciliation running...');
    const twoMinsAgo = new Date(Date.now() - 2 * 60 * 1000).getTime();
    // Single equality filter only, then filter by timestamp in
    // application code — a compound where() (status == AND
    // timestamp <=) requires a Firestore composite index, which the
    // rest of this file deliberately avoids (see toMillis() and the
    // note on sweepUnresolvedFunds() below). The limit is applied
    // AFTER the timestamp filter, not on the raw query — applying it
    // before would risk truncating to 50 pending transactions that
    // happen to all be too recent, silently skipping older ones that
    // are actually due for reconciliation.
    const pendingRawSnap = await db.collection('transactions')
      .where('status', '==', 'pending')
      .limit(500) // generous cap on how many "pending" docs we'll ever scan per run
      .get();

    const pendingDocs = pendingRawSnap.docs
      .filter(doc => toMillis(doc.data().timestamp) <= twoMinsAgo)
      .slice(0, 50);

    if (pendingDocs.length === 0) { console.log('✅ No pending transactions'); return; }

    for (const doc of pendingDocs) {
      const tx = doc.data();
      try {
        const result = await airtelTransactionStatus(tx.reference);
        const airtelStatus = result?.data?.transaction?.status;

        if (airtelStatus === 'TS') {
          await db.collection('transactions').doc(doc.id).update({
            status: 'completed', reconciledAt: FieldValue.serverTimestamp()
          });
          // Recompute the platform/Airtel split the same way it was
          // computed at save time — Airtel's cut is 1.5% of the
          // original transaction amount, and the platform keeps
          // whatever's left of the fee that was actually charged
          // (tx.fee). Using tx.amount here (not tx.fee) is what
          // makes this match the original calcFee() math exactly.
          // Shared by both branches below since the fee accounting
          // is identical regardless of where the money lands.
          if (tx.type === 'savings' && tx.uid) {
            const airtelAmount = Math.ceil((tx.amount || 0) * (AIRTEL_FEE_PERCENT / 100));
            const platformAmount = Math.max(0, (tx.fee || 0) - airtelAmount);

            if (tx.goalId) {
              // A savings transaction that carries a goalId is a
              // direct-to-goal autosave/roundup run (destination:
              // 'goal') — credit the goal exactly as before.
              await updateGoalProgress(tx.uid, tx.goalId, tx.amount);
              await logFee(tx.uid, { amount: tx.fee || 0, platformAmount, airtelAmount, transactionId: doc.id, type: 'savings_reconciled', plan: tx.plan });
              await pushNotification(tx.uid, {
                type: 'savings_reconciled',
                message: `✅ Your MWK ${(tx.amount || 0).toLocaleString()} save to ${tx.goalName} was confirmed.`
              });
              clearCache(`goals_${tx.uid}`, `analytics_${tx.uid}`);
            } else {
              // No goalId — this is a manual /api/save (or a
              // balance-destination autosave run) that was still
              // pending when the request originally returned. Credit
              // the user's accountBalance the same way the request
              // handler itself would have if Airtel had confirmed
              // in time.
              await db.collection('users').doc(tx.uid).set({
                accountBalance: FieldValue.increment(tx.amount || 0)
              }, { merge: true });
              await logFee(tx.uid, { amount: tx.fee || 0, platformAmount, airtelAmount, transactionId: doc.id, type: 'savings_reconciled', plan: tx.plan });
              await pushNotification(tx.uid, {
                type: 'savings_reconciled',
                message: `✅ Your MWK ${(tx.amount || 0).toLocaleString()} deposit to your account balance was confirmed.`
              });
              clearCache(`profile_${tx.uid}`, `analytics_${tx.uid}`);
            }
          }
        } else if (['TF', 'TE'].includes(airtelStatus)) {
          await db.collection('transactions').doc(doc.id).update({
            status: 'failed', reconciledAt: FieldValue.serverTimestamp()
          });
          if (tx.uid) {
            await pushNotification(tx.uid, {
              type: 'transaction_failed',
              message: `❌ Your MWK ${(tx.amount || 0).toLocaleString()} transaction failed. No money was moved.`
            });
          }
        }
      } catch (err) {
        console.error(`Reconciliation error for ${tx.reference}:`, err.message);
      }
    }
    console.log('✅ Reconciliation complete');
  } catch (err) {
    console.error('❌ Reconciliation error:', err.message);
  }
}

// ----------------------------
// FLOAT MONITOR
// ----------------------------
export async function monitorFloat() {
  // Float monitoring is genuinely Airtel-direct-only — PayChangu has
  // no merchant balance endpoint to poll (see _paychanguBalance()).
  // Skips cleanly rather than erroring when running under PayChangu.
  if (resolvePaymentProvider() !== 'airtel_direct') return;
  try {
    const data = await airtelBalance('DISB');
    const balance = parseFloat(data?.data?.balance || 0);
    console.log(`💰 Float: MWK ${balance.toLocaleString()}`);
    await db.collection('float_monitor').add({
      balance, currency: 'MWK',
      timestamp: FieldValue.serverTimestamp(),
      status: balance < FLOAT_THRESHOLD ? 'low' : 'ok'
    });
    if (balance < FLOAT_THRESHOLD) {
      console.warn(`🚨 LOW FLOAT: MWK ${balance.toLocaleString()}`);
      await db.collection('admin_alerts').add({
        type: 'low_float',
        message: `Float is low: MWK ${balance.toLocaleString()}. Top up required.`,
        balance, threshold: FLOAT_THRESHOLD,
        timestamp: FieldValue.serverTimestamp(),
        resolved: false
      });
      await sendExternalAlert('Low corporate float', `Balance: MWK ${balance.toLocaleString()} (threshold: MWK ${FLOAT_THRESHOLD.toLocaleString()}). Withdrawals may start failing — top up required.`);
    }
    cache.set('corporate_float', { data: balance, expiry: Date.now() + 5 * 60 * 1000 });
  } catch (err) {
    console.error('❌ Float monitor error:', err.message);
    logSystemError('float_monitor', err.message, { stack: err.stack });
  }
}

// ----------------------------
// SUBSCRIPTION EXPIRY CHECKER
// Runs daily — auto-downgrades expired subscriptions
// ----------------------------
export async function checkExpiredSubscriptions() {
  try {
    console.log('🔄 Checking expired subscriptions...');
    // Single equality filter, then filter by subscriptionExpiry in
    // application code — same reasoning as reconcilePendingTransactions()
    // above and sweepUnresolvedFunds() below: avoids requiring a
    // Firestore composite index for a mixed equality+range query.
    const rawSnap = await db.collection('users')
      .where('subscriptionActive', '==', true)
      .get();

    const now = Date.now();
    const expiredDocs = rawSnap.docs.filter(doc => (doc.data().subscriptionExpiry || 0) <= now);

    for (const doc of expiredDocs) {
      const user = doc.data();
      if (user.plan === 'free') continue;
      await db.collection('users').doc(doc.id).set({
        plan: 'free', subscriptionActive: false
      }, { merge: true });
      if (user.plan === 'business') await deactivateMerchantCode(doc.id);
      clearCache(`plan_${doc.id}`);
      await pushNotification(doc.id, {
        type: 'subscription_expired',
        message: `Your ${user.plan} plan has expired. Renew to keep access to all features.`
      });
      try {
        await freezeGoalsForExpiredSubscription(doc.id);
      } catch (e) {
        logSystemError('goal_freeze_on_expiry', e.message, { uid: doc.id, stack: e.stack });
      }
      console.log(`⬇️ Downgraded ${doc.id} from ${user.plan} to free`);
    }
    console.log('✅ Subscription check complete');
  } catch (err) {
    console.error('❌ Subscription check error:', err.message);
    logSystemError('subscription_checker', err.message, { stack: err.stack });
  }
}

// ----------------------------
// UNRESOLVED FUNDS SWEEP — DAY 60 ACCOUNT DELETION
// Runs daily. Finds soft-deleted accounts (accountDeleted: true) past
// their purgeDeadline (60 days from deletion — see POST
// /api/account/delete and POST /api/admin/users/:uid/delete) that
// still hold a non-zero accountBalance, and moves that balance into
// the unresolved_funds collection rather than treating it as
// platform revenue — this money was never earned, it's an orphaned
// user balance that nobody claimed within the recovery window.
//
// Deliberately does NOT touch platform_fees or log this as
// "savings_reconciled" or any revenue-shaped event — unresolved_funds
// is its own ledger specifically so a founder reviewing revenue never
// mistakes swept user balances for actual earnings.
//
// Does not delete the user document itself — marks it purged so it's
// excluded from future sweep runs, but leaves it in place since
// transactions/goals still reference the uid and are retained
// regardless of deletion (see the account deletion endpoints for
// why financial records outlive the account).
// ----------------------------
export async function sweepUnresolvedFunds() {
  try {
    console.log('🔄 Checking for unresolved funds from deleted accounts...');
    // Single equality filter only, then filter by purgeDeadline in
    // application code — a compound where() (accountDeleted ==
    // AND purgeDeadline <=) requires a Firestore composite index,
    // which every other job in this file deliberately avoids (see
    // toMillis() and the comment on GET /api/transactions). Deleted
    // accounts are not a high-volume collection, so fetching all of
    // them and filtering here is cheap and needs zero index
    // maintenance.
    const snap = await db.collection('users')
      .where('accountDeleted', '==', true)
      .get();

    const now = Date.now();
    let sweptCount = 0, sweptTotal = 0;
    for (const doc of snap.docs) {
      const user = doc.data();
      if (!user.purgeDeadline || user.purgeDeadline > now) continue; // not yet past the 60-day mark
      if (user.unresolvedFundsSwept) continue; // already processed by a previous run
      const balance = user.accountBalance || 0;

      if (balance > 0) {
        await db.collection('unresolved_funds').add({
          uid: doc.id,
          amount: balance,
          reason: 'account_deletion_unclaimed',
          originalDeletedAt: user.deletedAtMillis || null,
          sweptAt: FieldValue.serverTimestamp(),
          resolved: false
        });
        await db.collection('users').doc(doc.id).set({
          accountBalance: 0,
          unresolvedFundsSwept: true,
          unresolvedFundsSweptAt: FieldValue.serverTimestamp()
        }, { merge: true });
        sweptCount++;
        sweptTotal += balance;
        console.log(`💰 Swept MWK ${balance} from deleted account ${doc.id} to unresolved_funds`);
      } else {
        // Zero balance — nothing to sweep, just mark it so this
        // account isn't re-checked on every future run
        await db.collection('users').doc(doc.id).set({ unresolvedFundsSwept: true }, { merge: true });
      }
    }

    if (sweptCount > 0) {
      await db.collection('admin_alerts').add({
        message: `${sweptCount} deleted account${sweptCount !== 1 ? 's' : ''} had unclaimed balances totaling MWK ${sweptTotal.toLocaleString()}, moved to Unresolved Funds.`,
        type: 'unresolved_funds_swept',
        resolved: false,
        timestamp: FieldValue.serverTimestamp()
      });
      await sendExternalAlert(
        'Unresolved funds swept from deleted accounts',
        `${sweptCount} account(s), total MWK ${sweptTotal.toLocaleString()}. Review in the admin panel's Unresolved Funds ledger.`
      );
    }
    console.log(`✅ Unresolved funds sweep complete — ${sweptCount} account(s), MWK ${sweptTotal} total`);
  } catch (err) {
    console.error('❌ Unresolved funds sweep error:', err.message);
    logSystemError('unresolved_funds_sweep', err.message, { stack: err.stack });
  }
}

// ----------------------------
// SUBSCRIPTION-EXPIRY GOAL FREEZE
// Runs daily, right after checkExpiredSubscriptions(). Handles what
// happens to a hard-locked goal when the owning user's plan lapses.
//
// A hard lock (lockType === 'hard') requires Pro/Business — see
// POST /api/goals. If the subscription that earned that privilege
// expires, the goal is frozen rather than silently left as-is or
// silently unlocked: no new deposits (manual save or auto-save) can
// land in a frozen goal, but nothing already saved is touched and
// withdrawal rules are unchanged (still blocked while locked, same
// as before).
//
// The user is notified once (frozenPromptShown guards against
// re-notifying) and gets FREEZE_GRACE_DAYS to decide, via
// PATCH /api/goals/:goalId/frozen-decision, whether to:
//   - unlock now (lose the lock early, funds withdrawable), or
//   - keep it frozen and renew later
// If they never respond, checkFrozenGoalGracePeriod() (below)
// auto-unlocks after the grace window so funds are never stuck
// indefinitely just because a founder-side decision was never made.
//
// If the subscription renews before the grace window closes, the
// unfreezeGoalsOnRenewal() hook (called from the renewal endpoint)
// clears the freeze and restores normal lock behavior with no
// early-unlock penalty.
// ----------------------------
const FREEZE_GRACE_DAYS = 7;

async function freezeGoalsForExpiredSubscription(uid) {
  const snap = await db.collection('goals')
    .where('uid', '==', uid)
    .where('locked', '==', true)
    .where('lockType', '==', 'hard')
    .where('completed', '==', false)
    .get();

  for (const doc of snap.docs) {
    const goal = doc.data();
    if (goal.frozen) continue; // already frozen, don't re-notify or reset the grace clock

    await doc.ref.update({
      frozen: true,
      frozenAt: FieldValue.serverTimestamp(),
      frozenReason: 'subscription_expired',
      frozenGraceDeadline: Date.now() + FREEZE_GRACE_DAYS * 24 * 60 * 60 * 1000,
      frozenPromptShown: false,
      updatedAt: FieldValue.serverTimestamp()
    });

    await pushNotification(uid, {
      type: 'goal_frozen',
      topic: 'Goal Frozen',
      message: `🧊 Your subscription expired, so "${goal.name}" is frozen — no new savings can be added until you decide. Unlock it now, or keep it locked and renew within ${FREEZE_GRACE_DAYS} days. After that, it unlocks automatically.`
    });
  }
}

// ----------------------------
// FROZEN GOAL GRACE PERIOD CHECKER
// Runs daily — auto-unlocks any goal that's been frozen past its
// grace deadline without the user making an explicit choice.
// Mirrors checkGoalDeadlines()'s auto_unlock branch: this is a
// safety net, not the primary path — most users are expected to
// respond to the frozen-goal banner before this ever fires.
// ----------------------------
export async function checkFrozenGoalGracePeriod() {
  try {
    console.log('🔄 Checking frozen goal grace periods...');
    const snap = await db.collection('goals')
      .where('frozen', '==', true)
      .where('completed', '==', false)
      .get();

    let unlocked = 0;
    for (const doc of snap.docs) {
      const goal = doc.data();
      if (!goal.frozenGraceDeadline || goal.frozenGraceDeadline > Date.now()) continue;

      await doc.ref.update({
        frozen: false,
        locked: false,
        lockType: 'flexible',
        unlockedEarly: true,
        unlockReason: 'grace_period_expired',
        updatedAt: FieldValue.serverTimestamp()
      });
      await pushNotification(goal.uid, {
        type: 'goal_auto_unlocked_grace',
        topic: 'Goal Unlocked',
        message: `🔓 "${goal.name}" was frozen for ${FREEZE_GRACE_DAYS} days with no response, so it's been automatically unlocked. Withdraw anytime, or renew your subscription to lock goals again.`
      });
      unlocked++;
    }
    console.log(`✅ Frozen goal grace check complete — ${unlocked} auto-unlocked`);
  } catch (err) {
    console.error('❌ Frozen goal grace check error:', err.message);
    logSystemError('frozen_goal_grace_checker', err.message, { stack: err.stack });
  }
}

// Called from wherever a subscription renewal is confirmed (webhook
// or manual admin action) so a user who renews inside the grace
// window gets their lock back with no early-unlock penalty.
export async function unfreezeGoalsOnRenewal(uid) {
  const snap = await db.collection('goals')
    .where('uid', '==', uid)
    .where('frozen', '==', true)
    .where('completed', '==', false)
    .get();

  for (const doc of snap.docs) {
    const goal = doc.data();
    await doc.ref.update({
      frozen: false,
      frozenReason: FieldValue.delete(),
      frozenGraceDeadline: FieldValue.delete(),
      updatedAt: FieldValue.serverTimestamp()
    });
    await pushNotification(goal.uid, {
      type: 'goal_unfrozen',
      topic: 'Goal Unfrozen',
      message: `✅ Your subscription renewed — "${goal.name}" is unfrozen and back to normal. Keep saving!`
    });
  }
}

// ----------------------------
// GOAL DEADLINE CHECKER
// Runs daily — handles locked goals whose deadline has passed
// without reaching the savings target.
//
// Behavior depends on goal.deadlineBehavior:
//   stay_locked  -> do nothing except notify (informational only)
//   auto_unlock  -> unlock the goal automatically, notify user
//   ask_me       -> flag deadlineDecisionPending, notify user to choose
// ----------------------------
export async function checkGoalDeadlines() {
  try {
    console.log('🔄 Checking goal deadlines...');
    const todayStr = new Date().toISOString().split('T')[0];

    // Only locked, incomplete goals with a deadline can be affected
    const snap = await db.collection('goals')
      .where('locked', '==', true)
      .where('completed', '==', false)
      .get();

    let processed = 0;
    for (const doc of snap.docs) {
      const goal = doc.data();
      if (!goal.deadline || goal.deadlinePassed) continue;
      if (goal.deadline > todayStr) continue; // deadline still in the future

      const behavior = goal.deadlineBehavior || 'ask_me';
      const pct = goal.target > 0 ? Math.round(((goal.saved || 0) / goal.target) * 100) : 0;

      if (behavior === 'auto_unlock') {
        await doc.ref.update({
          locked: false,
          lockType: 'flexible',
          deadlinePassed: true,
          updatedAt: FieldValue.serverTimestamp()
        });
        await pushNotification(goal.uid, {
          type: 'goal_auto_unlocked',
          topic: 'Goal Deadline Reached',
          message: `🔓 "${goal.name}" reached its deadline at ${pct}% saved and has been automatically unlocked. Withdraw anytime.`
        });
      } else if (behavior === 'stay_locked') {
        await doc.ref.update({
          deadlinePassed: true,
          updatedAt: FieldValue.serverTimestamp()
        });
        await pushNotification(goal.uid, {
          type: 'goal_deadline_passed',
          topic: 'Goal Deadline Passed',
          message: `📌 "${goal.name}" passed its deadline at ${pct}% saved. It stays locked until you reach your MWK ${goal.target.toLocaleString()} target, as you chose.`
        });
      } else {
        // ask_me — flag for user decision, don't change lock state yet
        await doc.ref.update({
          deadlinePassed: true,
          deadlineDecisionPending: true,
          updatedAt: FieldValue.serverTimestamp()
        });
        await pushNotification(goal.uid, {
          type: 'goal_deadline_decision',
          topic: 'Decision Needed',
          message: `⏰ "${goal.name}" passed its deadline at ${pct}% saved. Open the goal to unlock it or extend the deadline.`
        });
      }
      processed++;
    }
    console.log(`✅ Goal deadline check complete — ${processed} goal(s) processed`);
  } catch (err) {
    console.error('❌ Goal deadline check error:', err.message);
    logSystemError('goal_deadline_checker', err.message, { stack: err.stack });
  }
}

// ----------------------------
// AUTO-SAVE: INCOME TRIGGER RESOLUTION
// Determines whether an income_percent rule should fire, and how
// much to base the percentage on.
//
// PayChangu path (unchanged, per explicit product decision): stays
// on the declared payday + declared income amount, since PayChangu
// has no way to see real wallet activity.
//
// Airtel-direct path (new): uses REAL incoming transactions from
// airtelTransactionSummary() instead of trusting a declared date —
// this is the "only act on money the user actually received" design.
// ----------------------------
async function resolveIncomeTrigger(rule, todayDate, user) {
  const provider = resolvePaymentProvider();

  if (provider !== 'airtel_direct') {
    // PayChangu / mock — declared payday behavior, exactly as before
    if (!rule.incomeDay || !rule.declaredIncome) return null;
    if (todayDate.getDate() !== rule.incomeDay) return null;
    return { amountBase: rule.declaredIncome, source: 'declared' };
  }

  // Airtel direct — check real recent incoming transactions
  if (!user?.phone) return null;
  const recent = await airtelTransactionSummary(user.phone, { sinceMinutes: 30 });
  const credits = recent.filter(tx => tx.direction === 'credit' && tx.amount >= 5000);
  if (credits.length === 0) return null;

  // Only react to credits we haven't already processed for this rule —
  // prevents charging the same incoming payment twice across job runs
  const unprocessed = [];
  for (const tx of credits) {
    const seenSnap = await db.collection('seen_wallet_transactions').doc(tx.id).get();
    if (!seenSnap.exists) unprocessed.push(tx);
  }
  if (unprocessed.length === 0) return null;

  // Take the largest unprocessed credit as "the income event" —
  // reasonable heuristic since salary payments are typically the
  // largest single credit in a short window
  const biggest = unprocessed.reduce((max, tx) => tx.amount > max.amount ? tx : max, unprocessed[0]);
  return { amountBase: biggest.amount, source: 'airtel_transaction_summary', txId: biggest.id, allCredits: unprocessed };
}

// ----------------------------
// AUTO-SAVE: ROUNDUP TRIGGER RESOLUTION (Airtel-direct only)
// Same real-transaction-based approach as income above, but for
// outgoing spends instead of incoming credits. PayChangu/mock users
// keep using the manual POST /api/roundup endpoint, which is
// untouched by any of this.
// ----------------------------
async function resolveRoundupTrigger(rule, user) {
  if (resolvePaymentProvider() !== 'airtel_direct') return null;
  if (!user?.phone) return null;

  const recent = await airtelTransactionSummary(user.phone, { sinceMinutes: 30 });
  const debits = recent.filter(tx => tx.direction === 'debit' && tx.amount > 0);
  if (debits.length === 0) return null;

  const unprocessed = [];
  for (const tx of debits) {
    const seenSnap = await db.collection('seen_wallet_transactions').doc(tx.id).get();
    if (!seenSnap.exists) unprocessed.push(tx);
  }
  return unprocessed.length > 0 ? unprocessed : null;
}

// ----------------------------
// TRANSACTION SUMMARY POLLER (Airtel-direct only)
// Runs frequently (every 5 minutes) as a safety net that catches
// real income and real spending as close to "the moment it happens"
// as a polling approach allows, per the product decision to react
// "before the user thinks of spending it" rather than waiting for a
// slow daily cycle. If Airtel's API later exposes a genuine webhook
// for wallet activity, that would notify us instantly instead — this
// polling loop would then just become the backup safety net rather
// than the primary mechanism, with zero changes needed to the trigger
// resolution functions above.
//
// Marks every transaction it looks at as "seen" regardless of whether
// a rule acted on it, so the same wallet activity is never evaluated
// twice — whether or not it happened to match a rule this time.
// ----------------------------

// ----------------------------
// PROACTIVE ANOMALY MONITOR (Improvement #4 — noticing on its own)
// Runs the same rule-based flagging used by the on-demand anomaly
// scan, but automatically on a schedule, and only creates an
// admin_alert (and thus interrupts the founder) for genuinely NEW
// high-risk findings — not re-alerting on the same user every run.
// ----------------------------
export async function proactiveAnomalyCheck() {
  try {
    const [txSnap, usersSnap] = await Promise.all([
      db.collection('transactions').limit(500).get(),
      db.collection('users').limit(500).get(),
    ]);
    const transactions = []; txSnap.forEach(d => transactions.push({ id: d.id, ...d.data() }));
    const users = {}; usersSnap.forEach(d => { users[d.id] = d.data(); });

    const byUser = {};
    transactions.forEach(t => {
      if (!byUser[t.uid]) byUser[t.uid] = [];
      byUser[t.uid].push(t);
    });

    const flagged = [];
    for (const [uid, txs] of Object.entries(byUser)) {
      const large = txs.filter(t => t.amount > 500000);
      const rapid = txs.filter((t, i) => {
        if (i === 0) return false;
        const gap = Math.abs(toMillis(t.timestamp) - toMillis(txs[i - 1].timestamp));
        return gap < 5 * 60 * 1000;
      });
      const failedCount = txs.filter(t => t.status === 'failed').length;
      if (large.length > 0 || rapid.length >= 3 || failedCount >= 3) {
        flagged.push({ uid, email: users[uid]?.email || uid, largeTransactions: large.length, rapidTransactions: rapid.length, failedTransactions: failedCount });
      }
    }

    if (flagged.length === 0) return;

    // Only alert on users we haven't already raised an unresolved
    // alert for — prevents the same pattern re-notifying every run
    const existingAlertsSnap = await db.collection('admin_alerts')
      .where('type', '==', 'ai_anomaly').where('resolved', '==', false).get();
    const alreadyAlertedUids = new Set();
    existingAlertsSnap.forEach(d => { if (d.data().uid) alreadyAlertedUids.add(d.data().uid); });

    const newlyFlagged = flagged.filter(f => !alreadyAlertedUids.has(f.uid));
    if (newlyFlagged.length === 0) return;

    for (const f of newlyFlagged) {
      const reasonParts = [];
      if (f.largeTransactions) reasonParts.push(`${f.largeTransactions} large transaction(s)`);
      if (f.rapidTransactions >= 3) reasonParts.push(`${f.rapidTransactions} rapid-fire transactions`);
      if (f.failedTransactions >= 3) reasonParts.push(`${f.failedTransactions} failed transactions`);

      await db.collection('admin_alerts').add({
        type: 'ai_anomaly',
        uid: f.uid,
        message: `Unusual activity: ${f.email} — ${reasonParts.join(', ')}. Ask the AI Assistant for details.`,
        timestamp: FieldValue.serverTimestamp(),
        resolved: false
      });
    }
    console.log(`🔎 Proactive anomaly check: ${newlyFlagged.length} new pattern(s) flagged`);
  } catch (err) {
    console.error('❌ Proactive anomaly check error:', err.message);
    logSystemError('proactive_anomaly_check', err.message, { stack: err.stack });
  }
}

export async function checkTransactionSummaries() {
  if (resolvePaymentProvider() !== 'airtel_direct') return; // no-op on PayChangu/mock, by design
  try {
    console.log('🔄 Checking live transaction summaries...');
    const rulesSnap = await db.collection('autosave_rules')
      .where('enabled', '==', true)
      .where('type', 'in', ['income_percent', 'roundup'])
      .get();

    if (rulesSnap.empty) { console.log('✅ No income/roundup rules to check'); return; }

    // Group rules by user so we only fetch each user's transaction
    // summary once per run, even if they have multiple rules
    const rulesByUid = {};
    rulesSnap.forEach(doc => {
      const rule = { id: doc.id, ...doc.data() };
      if (!rulesByUid[rule.uid]) rulesByUid[rule.uid] = [];
      rulesByUid[rule.uid].push(rule);
    });

    let triggered = 0;

    for (const [uid, rules] of Object.entries(rulesByUid)) {
      const userSnap = await db.collection('users').doc(uid).get();
      const user = userSnap.data();
      if (!user?.phone) continue;
      const isVerified = user.kycStatus === 'verified' || user.kycStatus === 'mock_verified';
      if (!isVerified) continue;

      const incomeRules = rules.filter(r => r.type === 'income_percent');
      const roundupRules = rules.filter(r => r.type === 'roundup');

      // --- Income rules: real credit detected ---
      for (const rule of incomeRules) {
        const trigger = await resolveIncomeTrigger(rule, new Date(), user);
        if (!trigger || trigger.source !== 'airtel_transaction_summary') continue;

        const amountToSave = Math.round(trigger.amountBase * (rule.percent / 100));
        if (amountToSave < SECURITY.MIN_SAVE_AMOUNT) continue;

        const executed = await executeAutosaveCollection(rule, user, amountToSave,
          `↻ Income detected — saved ${rule.percent}% (MWK ${amountToSave.toLocaleString()}) automatically.`);
        if (executed) triggered++;

        // Mark every credit we looked at as seen, whether or not it
        // ended up being the one we acted on, so it's never re-evaluated
        for (const tx of trigger.allCredits) {
          await db.collection('seen_wallet_transactions').doc(tx.id).set({
            uid, direction: 'credit', amount: tx.amount,
            seenAt: FieldValue.serverTimestamp()
          });
        }
      }

      // --- Roundup rules: real spend detected ---
      for (const rule of roundupRules) {
        const debits = await resolveRoundupTrigger(rule, user);
        if (!debits) continue;

        for (const tx of debits) {
          const roundedUp = Math.ceil(tx.amount / 500) * 500;
          const roundUpAmount = roundedUp - tx.amount;

          if (roundUpAmount >= 10) {
            const executed = await executeAutosaveCollection(rule, user, roundUpAmount,
              `🔄 Round-up: MWK ${roundUpAmount.toLocaleString()} saved automatically from a MWK ${tx.amount.toLocaleString()} spend.`,
              { type: 'roundup', spendAmount: tx.amount, roundedUp });
            if (executed) triggered++;
          }

          await db.collection('seen_wallet_transactions').doc(tx.id).set({
            uid, direction: 'debit', amount: tx.amount,
            seenAt: FieldValue.serverTimestamp()
          });
        }
      }
    }

    console.log(`✅ Transaction summary check complete — ${triggered} auto-save(s) triggered`);
  } catch (err) {
    console.error('❌ Transaction summary check error:', err.message);
    logSystemError('transaction_summary_poller', err.message, { stack: err.stack });
  }
}

// ----------------------------
// SHARED COLLECTION EXECUTOR
// Used by both the scheduled runAutosaveRules() job (weekly/monthly/
// declared-income) and the new checkTransactionSummaries() poller
// (real income/real spend) so there is exactly one code path that
// actually calls the payment provider and credits a goal — avoiding
// two subtly different implementations of "what happens when an
// auto-save succeeds".
// ----------------------------
async function executeAutosaveCollection(rule, user, amountToSave, notifyMessage, extraTxFields = {}) {
  try {
    const toGoal = rule.destination === 'goal';
    let goal = null;

    if (toGoal) {
      const goalSnap = await db.collection('goals').doc(rule.goalId).get();
      goal = goalSnap.data();
      if (!goal || goal.completed) return false;
      if (goal.frozen) {
        await db.collection('autosave_rules').doc(rule.id).update({
          lastRun: FieldValue.serverTimestamp(), lastRunResult: 'skipped_goal_frozen'
        });
        return false;
      }
    }

    const { plan, config } = await getPlanConfig(rule.uid);
    const fee = calcFee(amountToSave, config.transactionFeePercent);
    const reference = generateRef();

    let succeeded = false;
    if (isMockMode()) {
      succeeded = true;
    } else {
      const result = await airtelCollect({ phone: user.phone, amount: amountToSave, reference });
      succeeded = isAirtelSuccess(result);
    }

    if (!succeeded) {
      await pushNotification(rule.uid, {
        type: 'autosave_failed',
        message: `⚠ Auto-save ${toGoal ? `for ${goal.name}` : ''} couldn't go through this time. Check your Airtel Money balance.`
      });
      return false;
    }

    // destination === 'goal' allocates straight into the goal, same
    // as before; destination === 'balance' credits accountBalance —
    // the same choice a manual save now leaves open, just automated.
    if (toGoal) {
      await updateGoalProgress(rule.uid, rule.goalId, amountToSave);
    } else {
      await db.collection('users').doc(rule.uid).set({
        accountBalance: FieldValue.increment(amountToSave)
      }, { merge: true });
    }

    const txId = await logTransaction(rule.uid, {
      type: 'savings', amount: amountToSave, fee: fee.total, feePercent: config.transactionFeePercent,
      goalId: toGoal ? rule.goalId : null, goalName: toGoal ? goal.name : null, reference,
      status: isMockMode() ? 'mock' : 'completed', phone: user.phone, plan,
      source: 'autosave_rule', ruleId: rule.id, ...extraTxFields
    });
    await logFee(rule.uid, { amount: fee.total, platformAmount: fee.platformAmount, airtelAmount: fee.airtelAmount, transactionId: txId, type: 'savings', plan });
    await pushNotification(rule.uid, { type: 'autosave_success', message: notifyMessage });
    await db.collection('autosave_rules').doc(rule.id).update({
      lastRun: FieldValue.serverTimestamp(), lastRunResult: 'success'
    });
    return true;
  } catch (err) {
    console.error(`❌ Auto-save execution failed for rule ${rule.id}:`, err.message);
    logSystemError('autosave_execution', err.message, { ruleId: rule.id, uid: rule.uid, stack: err.stack });
    await db.collection('autosave_rules').doc(rule.id).update({
      lastRun: FieldValue.serverTimestamp(), lastRunResult: 'error'
    }).catch(() => {});
    return false;
  }
}

// ----------------------------
// AUTO-SAVE: RULE EXECUTION
// Runs daily. Processes weekly, monthly, and income_percent rules
// (roundup rules are triggered directly from /api/roundup when a
// spend happens, not on a schedule, so they're not handled here).
//
// Reuses the exact same collection path as a manual save — same
// airtelCollect()/isAirtelSuccess() calls, same updateGoalProgress(),
// logTransaction(), logFee(), pushNotification() — so switching the
// underlying payment provider (Airtel direct vs PayChangu) requires
// zero changes here; that swap only ever happens inside airtelCollect()
// itself.
// ----------------------------
export async function runAutosaveRules() {
  try {
    console.log('🔄 Running auto-save rules (weekly / monthly / declared-income)...');
    const today = new Date();
    const todayDow = today.getDay(); // 0=Sun..6=Sat
    const todayDate = today.getDate();
    const provider = resolvePaymentProvider();

    const snap = await db.collection('autosave_rules').where('enabled', '==', true).get();
    let processed = 0, skipped = 0, failed = 0;

    for (const doc of snap.docs) {
      const rule = { id: doc.id, ...doc.data() };

      // Avoid double-running the same rule twice in one calendar day
      // if the job ever gets triggered more than once (e.g. manual re-run)
      const lastRunDay = rule.lastRun ? new Date(toMillis(rule.lastRun)).toDateString() : null;
      if (lastRunDay === today.toDateString()) { skipped++; continue; }

      let amountToSave = null;
      let ruleLabel = '';

      if (rule.type === 'weekly') {
        // schedule stores which day of week, e.g. "MON".."SUN" — default Monday
        const days = { SUN: 0, MON: 1, TUE: 2, WED: 3, THU: 4, FRI: 5, SAT: 6 };
        const targetDow = days[(rule.schedule || 'MON').toUpperCase()] ?? 1;
        if (todayDow !== targetDow) continue;
        amountToSave = rule.amount;
        ruleLabel = 'Weekly auto-save';
      } else if (rule.type === 'monthly') {
        // schedule stores day-of-month as a string, e.g. "1"
        const targetDate = parseInt(rule.schedule, 10) || 1;
        if (todayDate !== targetDate) continue;
        amountToSave = rule.amount;
        ruleLabel = 'Monthly auto-save';
      } else if (rule.type === 'income_percent' && provider !== 'airtel_direct') {
        // On Airtel direct, income_percent is handled by
        // checkTransactionSummaries() reacting to real incoming money —
        // this daily job only covers the PayChangu/mock declared-date path
        const userSnap = await db.collection('users').doc(rule.uid).get();
        const trigger = await resolveIncomeTrigger(rule, today, userSnap.data());
        if (!trigger) continue;
        amountToSave = Math.round(trigger.amountBase * (rule.percent / 100));
        ruleLabel = `Income auto-save (${rule.percent}% of declared income)`;
      } else {
        continue; // roundup, or income_percent already covered by the live poller
      }

      if (!amountToSave || amountToSave < SECURITY.MIN_SAVE_AMOUNT) { skipped++; continue; }

      const userSnap = await db.collection('users').doc(rule.uid).get();
      const user = userSnap.data();

      if (!user) { skipped++; continue; }
      const isVerified = user.kycStatus === 'verified' || user.kycStatus === 'mock_verified';
      if (!isVerified || !user.phone) {
        await doc.ref.update({ lastRun: FieldValue.serverTimestamp(), lastRunResult: 'skipped_kyc_required' });
        skipped++; continue;
      }

      const executed = await executeAutosaveCollection(rule, user, amountToSave,
        `↻ ${ruleLabel}: MWK ${amountToSave.toLocaleString()} saved automatically.`);
      if (executed) processed++; else failed++;
    }

    console.log(`✅ Auto-save run complete — ${processed} saved, ${skipped} skipped, ${failed} failed`);
  } catch (err) {
    console.error('❌ Auto-save job error:', err.message);
    logSystemError('autosave_job', err.message, { stack: err.stack });
  }
}
