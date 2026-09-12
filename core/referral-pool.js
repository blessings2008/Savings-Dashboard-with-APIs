import crypto from 'crypto';
import { db, FieldValue } from './firebase.js';

export const REFERRAL_BONUS_MWK = 500;
export const REFERRAL_LIFETIME_CAP = 10;
const POOL_ID = 'referral';

const poolRef = () => db.collection('platform_pools').doc(POOL_ID);
const ledger = () => db.collection('platform_pool_ledger');
const idemRef = key => db.collection('platform_pool_idempotency').doc(
  crypto.createHash('sha256').update(String(key)).digest('hex')
);

function num(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

async function notify(uid, message) {
  await db.collection('notifications').add({
    uid,
    type: 'referral_bonus',
    message,
    read: false,
    timestamp: FieldValue.serverTimestamp()
  });
}

async function logBonusTransaction(uid, amount) {
  const ref = db.collection('transactions').doc();
  await ref.set({
    uid,
    type: 'referral_bonus',
    amount,
    fee: 0,
    feePercent: 0,
    reference: `REF-${crypto.randomBytes(6).toString('hex').toUpperCase()}`,
    status: 'completed',
    timestamp: FieldValue.serverTimestamp()
  });
  return ref.id;
}

export async function completeReferralFromPool(uid) {
  const userSnap = await db.collection('users').doc(uid).get();
  const user = userSnap.data();
  if (!user?.referredBy) return null;

  const referralSnap = await db.collection('referrals')
    .where('referredUid', '==', uid)
    .where('status', '==', 'pending')
    .limit(1)
    .get();
  if (referralSnap.empty) return null;

  const referralDoc = referralSnap.docs[0];
  const referral = referralDoc.data();
  const isVerified = user.kycStatus === 'verified' || user.kycStatus === 'mock_verified';
  if (!isVerified) return null;

  const referrerUid = referral.referrerUid;
  const referrerSnap = await db.collection('users').doc(referrerUid).get();
  const referrer = referrerSnap.data() || {};

  if (num(referrer.referralCount) >= REFERRAL_LIFETIME_CAP) {
    await referralDoc.ref.update({
      status: 'capped',
      rewardStatus: 'denied',
      note: `Referrer had already reached the ${REFERRAL_LIFETIME_CAP}-referral lifetime cap`,
      resolvedAt: FieldValue.serverTimestamp()
    });
    return null;
  }

  const fingerprintMatch = !!user.deviceFingerprint
    && !!referrer.deviceFingerprint
    && user.deviceFingerprint === referrer.deviceFingerprint;

  if (fingerprintMatch) {
    await referralDoc.ref.update({
      status: 'flagged_review',
      flaggedReason: 'device_fingerprint_match',
      flaggedAt: FieldValue.serverTimestamp(),
      bonusAmount: REFERRAL_BONUS_MWK,
      rewardStatus: 'pending'
    });
    await db.collection('admin_alerts').add({
      message: 'Referral flagged for review: referrer and referred user share a device fingerprint.',
      type: 'referral_flagged',
      referralId: referralDoc.id,
      referrerUid,
      referredUid: uid,
      resolved: false,
      timestamp: FieldValue.serverTimestamp()
    });
    return { flagged: true, referrerId: referrerUid, referredUid: uid };
  }

  const each = REFERRAL_BONUS_MWK;
  const total = each * 2;
  const idempotencyKey = `reward:${referralDoc.id}`;
  const idem = idemRef(idempotencyKey);

  const result = await db.runTransaction(async tx => {
    const [poolSnap, idemSnap, currentReferralSnap] = await Promise.all([
      tx.get(poolRef()),
      tx.get(idem),
      tx.get(referralDoc.ref)
    ]);

    if (idemSnap.exists) return { alreadyPaid: true, ...idemSnap.data() };

    const currentReferral = currentReferralSnap.data() || {};
    if (currentReferral.rewardStatus === 'paid') return { alreadyPaid: true };
    if (currentReferral.status !== 'pending') return null;

    const pool = poolSnap.exists ? poolSnap.data() : {};
    const balance = num(pool.availableBalance);
    if (balance < total) {
      // Do not mark the referral complete when funding is insufficient.
      // It remains pending until an admin funds the Referral Pool.
      return { pendingFunding: true, required: total, available: balance };
    }

    const entry = ledger().doc();
    tx.set(poolRef(), {
      availableBalance: balance - total,
      totalPaid: num(pool.totalPaid) + total,
      updatedAt: FieldValue.serverTimestamp()
    }, { merge: true });

    tx.set(entry, {
      type: 'reward',
      pool: POOL_ID,
      direction: 'debit',
      amount: total,
      reference: referralDoc.id,
      referrerUid,
      referredUid: uid,
      createdAt: FieldValue.serverTimestamp(),
      idempotencyKey,
      source: 'automatic_referral_completion'
    });

    tx.create(idem, {
      success: true,
      paid: total,
      each,
      ledgerId: entry.id,
      referralId: referralDoc.id,
      createdAt: FieldValue.serverTimestamp()
    });

    tx.set(db.collection('users').doc(referrerUid), {
      accountBalance: FieldValue.increment(each),
      referralCount: FieldValue.increment(1)
    }, { merge: true });
    tx.set(db.collection('users').doc(uid), {
      accountBalance: FieldValue.increment(each)
    }, { merge: true });
    tx.set(referralDoc.ref, {
      status: 'completed',
      rewardStatus: 'paid',
      bonusAmount: each,
      completedAt: FieldValue.serverTimestamp(),
      rewardPaidAt: FieldValue.serverTimestamp(),
      rewardPoolLedgerId: entry.id
    }, { merge: true });

    return { paid: total, each, ledgerId: entry.id };
  });

  if (!result || result.pendingFunding || result.alreadyPaid) return result;

  await Promise.all([
    logBonusTransaction(referrerUid, each),
    logBonusTransaction(uid, each),
    notify(referrerUid, `You earned a MWK ${each.toLocaleString()} referral bonus, added to your account balance!`),
    notify(uid, `You earned a MWK ${each.toLocaleString()} referral bonus, added to your account balance!`)
  ]);

  return { referrerId: referrerUid, referredUid: uid, bonusAmount: each, ...result };
}
