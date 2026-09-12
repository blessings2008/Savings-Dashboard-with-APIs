import { db, FieldValue } from './firebase.js';

const POOL_ID = 'referral';
const poolRef = () => db.collection('platform_pools').doc(POOL_ID);
const ledgerRef = () => db.collection('platform_pool_ledger');

export async function getReferralPool() {
  const snap = await poolRef().get();
  return snap.exists ? snap.data() : {
    availableBalance: 0, totalFunded: 0, totalPaid: 0,
    pendingRewards: 0, status: 'active', createdAt: FieldValue.serverTimestamp()
  };
}

export async function fundReferralPool({ source, amount, reference = '', actor = 'admin', idempotencyKey }) {
  if (!['main_pool', 'airtel'].includes(source)) throw new Error('Invalid funding source');
  if (!Number.isInteger(amount) || amount <= 0) throw new Error('Amount must be a positive whole number');
  if (source === 'airtel' && !reference) throw new Error('Airtel transaction reference is required');
  if (!idempotencyKey) throw new Error('Idempotency key is required');

  const result = await db.runTransaction(async tx => {
    const existing = await db.collection('platform_pool_ledger').where('idempotencyKey', '==', idempotencyKey).limit(1).get();
    if (!existing.empty) return { duplicate: true, ...existing.docs[0].data() };

    const ref = poolRef();
    const snap = await tx.get(ref);
    const current = snap.exists ? snap.data() : {};
    const next = Number(current.availableBalance || 0) + amount;
    tx.set(ref, {
      availableBalance: next,
      totalFunded: Number(current.totalFunded || 0) + amount,
      status: current.status || 'active',
      updatedAt: FieldValue.serverTimestamp(),
      ...(snap.exists ? {} : { totalPaid: 0, pendingRewards: 0, createdAt: FieldValue.serverTimestamp() })
    }, { merge: true });

    const entry = {
      pool: POOL_ID, direction: 'credit', amount, source,
      reference: reference || null, actor, idempotencyKey,
      reason: 'referral_pool_funding', createdAt: FieldValue.serverTimestamp()
    };
    const ledger = ledgerRef().doc();
    tx.set(ledger, entry);
    return { ...entry, id: ledger.id, availableBalance: next };
  });
  return result;
}

export async function debitReferralPool({ amount, reference, actor = 'system', reason = 'referral_reward', idempotencyKey }) {
  if (!Number.isInteger(amount) || amount <= 0) throw new Error('Amount must be a positive whole number');
  if (!idempotencyKey) throw new Error('Idempotency key is required');

  return db.runTransaction(async tx => {
    const existing = await db.collection('platform_pool_ledger').where('idempotencyKey', '==', idempotencyKey).limit(1).get();
    if (!existing.empty) return { duplicate: true, ...existing.docs[0].data() };

    const ref = poolRef();
    const snap = await tx.get(ref);
    const current = snap.exists ? snap.data() : {};
    const available = Number(current.availableBalance || 0);
    if (available < amount) throw new Error('Insufficient referral pool balance');

    const next = available - amount;
    tx.set(ref, {
      availableBalance: next,
      totalPaid: Number(current.totalPaid || 0) + amount,
      updatedAt: FieldValue.serverTimestamp()
    }, { merge: true });
    const ledger = ledgerRef().doc();
    tx.set(ledger, {
      pool: POOL_ID, direction: 'debit', amount, source: 'referral_pool',
      reference: reference || null, actor, reason, idempotencyKey,
      createdAt: FieldValue.serverTimestamp()
    });
    return { id: ledger.id, amount, availableBalance: next };
  });
}
