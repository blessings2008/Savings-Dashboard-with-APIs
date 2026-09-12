import express from 'express';
import crypto from 'crypto';
import { db, FieldValue } from '../core/firebase.js';
import { requireAdmin } from '../core/middleware.js';

const router = express.Router();
const POOL_ID = 'referral';
const DEFAULT_REWARD = 500;
const poolRef = () => db.collection('platform_pools').doc(POOL_ID);
const ledger = () => db.collection('platform_pool_ledger');
const idemRef = key => db.collection('platform_pool_idempotency').doc(
  crypto.createHash('sha256').update(String(key)).digest('hex')
);

function num(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function clean(value) {
  return typeof value === 'string' ? value.trim().slice(0, 200) : '';
}

function asMillis(value) {
  if (!value) return 0;
  if (typeof value.toMillis === 'function') return value.toMillis();
  if (value._seconds) return value._seconds * 1000;
  if (typeof value === 'number') return value;
  return new Date(value).getTime() || 0;
}

async function getPool() {
  const snap = await poolRef().get();
  return snap.exists
    ? snap.data()
    : { availableBalance: 0, totalFunded: 0, totalPaid: 0, status: 'active' };
}

function referralUsers(referral) {
  return {
    referrerUid: referral.referrerUid || null,
    referredUid: referral.referredUid || referral.referredUserUid || referral.uid || null,
  };
}

function isEligible(referral) {
  return ['completed', 'flagged_review', 'eligible'].includes(String(referral.status || '').toLowerCase())
    || referral.eligible === true
    || referral.rewardEligible === true;
}

async function payReferralReward(referralId) {
  const referralRef = db.collection('referrals').doc(referralId);
  const snap = await referralRef.get();
  if (!snap.exists) throw new Error('Referral not found');

  const referral = snap.data();
  if (referral.rewardStatus === 'paid') return { alreadyPaid: true };
  if (!isEligible(referral)) throw new Error('Referral is not eligible for reward');

  const { referrerUid, referredUid } = referralUsers(referral);
  if (!referrerUid || !referredUid) throw new Error('Referral participants are incomplete');

  const each = num(referral.bonusAmount || referral.rewardAmount || DEFAULT_REWARD);
  if (!Number.isInteger(each) || each <= 0) throw new Error('Invalid reward amount');

  const total = each * 2;
  const idempotencyKey = `reward:${referralId}`;
  const idem = idemRef(idempotencyKey);

  return db.runTransaction(async tx => {
    const [poolSnap, idemSnap, referralSnap] = await Promise.all([
      tx.get(poolRef()),
      tx.get(idem),
      tx.get(referralRef),
    ]);

    if (idemSnap.exists) return { alreadyPaid: true, ...idemSnap.data() };

    const currentReferral = referralSnap.data() || {};
    if (currentReferral.rewardStatus === 'paid') return { alreadyPaid: true };
    if (!isEligible(currentReferral)) throw new Error('Referral is not eligible for reward');

    const pool = poolSnap.exists ? poolSnap.data() : {};
    const balance = num(pool.availableBalance);
    if (balance < total) throw new Error('Insufficient referral pool balance');

    const entry = ledger().doc();
    tx.set(poolRef(), {
      availableBalance: balance - total,
      totalPaid: num(pool.totalPaid) + total,
      updatedAt: FieldValue.serverTimestamp(),
    }, { merge: true });

    tx.set(entry, {
      type: 'reward',
      pool: POOL_ID,
      direction: 'debit',
      amount: total,
      reference: referralId,
      referrerUid,
      referredUid,
      createdAt: FieldValue.serverTimestamp(),
      idempotencyKey,
    });

    tx.create(idem, {
      success: true,
      paid: total,
      each,
      ledgerId: entry.id,
      referralId,
      createdAt: FieldValue.serverTimestamp(),
    });

    tx.set(db.collection('users').doc(referrerUid), {
      accountBalance: FieldValue.increment(each),
      referralCount: FieldValue.increment(1),
    }, { merge: true });
    tx.set(db.collection('users').doc(referredUid), {
      accountBalance: FieldValue.increment(each),
    }, { merge: true });
    tx.set(referralRef, {
      rewardStatus: 'paid',
      rewardPaidAt: FieldValue.serverTimestamp(),
      rewardPoolLedgerId: entry.id,
      status: 'completed',
      completedAt: FieldValue.serverTimestamp(),
    }, { merge: true });

    return { paid: total, each, ledgerId: entry.id };
  });
}

// Dedicated referral overview and participant tracking.
router.get('/api/admin/referrals/overview', requireAdmin, async (req, res) => {
  const [pool, referralSnap] = await Promise.all([
    getPool(),
    db.collection('referrals').orderBy('createdAt', 'desc').limit(1000).get()
      .catch(() => db.collection('referrals').limit(1000).get()),
  ]);

  const referrals = referralSnap.docs.map(doc => ({ id: doc.id, ...doc.data() }));
  const ids = new Set();
  referrals.forEach(referral => {
    const users = referralUsers(referral);
    if (users.referrerUid) ids.add(users.referrerUid);
    if (users.referredUid) ids.add(users.referredUid);
  });

  const users = {};
  await Promise.all([...ids].slice(0, 400).map(async uid => {
    try {
      const snap = await db.collection('users').doc(uid).get();
      if (snap.exists) users[uid] = snap.data();
    } catch (_) {}
  }));

  const rows = referrals.map(referral => {
    const { referrerUid, referredUid } = referralUsers(referral);
    const referred = users[referredUid] || {};
    const referrer = users[referrerUid] || {};
    const kycStatus = referral.kycStatus || referred.kycStatus
      || (referred.kycVerified ? 'verified' : 'pending');

    return {
      id: referral.id,
      referrerName: referrer.name || referrer.displayName || referrer.email || referrerUid,
      referredName: referred.name || referred.displayName || referred.email || referredUid,
      referrerEmail: referrer.email || '',
      referredEmail: referred.email || '',
      kycStatus,
      firstSave: Boolean(referral.firstSave || referral.firstSaveConfirmed || referral.firstRealSave || referral.completed),
      eligible: Boolean(referral.eligible || referral.rewardEligible || referral.status === 'eligible' || referral.status === 'completed' || referral.status === 'flagged_review'),
      rewardAmount: num(referral.rewardAmount || referral.bonusAmount || DEFAULT_REWARD),
      rewardStatus: referral.rewardStatus || referral.rewardState || referral.status || 'pending',
      flagged: Boolean(referral.flagged || referral.reviewRequired || referral.abuseFlag || referral.status === 'flagged_review'),
    };
  });

  const pendingRewards = rows
    .filter(row => row.eligible && !['paid', 'completed'].includes(String(row.rewardStatus).toLowerCase()))
    .reduce((sum, row) => sum + row.rewardAmount * 2, 0);

  res.json({
    pool: {
      availableBalance: num(pool.availableBalance),
      totalFunded: num(pool.totalFunded),
      totalPaid: num(pool.totalPaid),
      pendingRewards,
      status: pool.status || 'active',
    },
    settings: { rewardAmount: DEFAULT_REWARD },
    enabled: pool.status !== 'paused',
    stats: { totalParticipants: ids.size, totalReferrals: rows.length },
    referrals: rows,
  });
});

router.get('/api/admin/referrals/pool/ledger', requireAdmin, async (req, res) => {
  const snap = await ledger().where('pool', '==', POOL_ID).limit(500).get();
  const entries = snap.docs.map(doc => ({ id: doc.id, ...doc.data() }))
    .sort((a, b) => asMillis(b.createdAt) - asMillis(a.createdAt))
    .slice(0, 200);
  res.json({ success: true, entries });
});

// Fund from an existing platform pool or record a confirmed Airtel deposit.
router.post('/api/admin/referrals/pool/fund', requireAdmin, async (req, res) => {
  const source = clean(req.body?.source);
  const amount = num(req.body?.amount);
  const reference = clean(req.body?.reference);
  const key = clean(req.get('Idempotency-Key')) || `${source}:${reference}:${amount}`;

  if (!['main_pool', 'airtel'].includes(source)) {
    return res.status(400).json({ error: 'Invalid funding source' });
  }
  if (!Number.isInteger(amount) || amount <= 0) {
    return res.status(400).json({ error: 'Amount must be a positive whole MWK amount' });
  }
  if (source === 'airtel' && !reference) {
    return res.status(400).json({ error: 'A confirmed Airtel transaction reference is required' });
  }

  const idem = idemRef(key);
  const existing = await idem.get();
  if (existing.exists) return res.json({ success: true, duplicate: true, ...existing.data() });

  if (source === 'main_pool' && !process.env.REFERRAL_MAIN_POOL_DOC) {
    return res.status(409).json({
      error: 'Main Pool transfer is not configured. Set REFERRAL_MAIN_POOL_DOC to the existing Main Pool document.',
    });
  }

  const pool = poolRef();
  const main = source === 'main_pool'
    ? db.collection('platform_pools').doc(process.env.REFERRAL_MAIN_POOL_DOC)
    : null;
  const entryId = `fund_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;

  try {
    await db.runTransaction(async tx => {
      const poolSnap = await tx.get(pool);
      const current = poolSnap.exists ? num(poolSnap.data().availableBalance) : 0;

      if (main) {
        const mainSnap = await tx.get(main);
        if (!mainSnap.exists) throw new Error('Configured Main Pool does not exist');
        const mainData = mainSnap.data();
        const balance = num(mainData.availableBalance ?? mainData.balance);
        if (balance < amount) throw new Error('Main Pool has insufficient available balance');
        tx.update(main, {
          availableBalance: balance - amount,
          balance: balance - amount,
          updatedAt: FieldValue.serverTimestamp(),
        });
      }

      tx.set(pool, {
        availableBalance: current + amount,
        totalFunded: num(poolSnap.exists ? poolSnap.data().totalFunded : 0) + amount,
        status: poolSnap.exists ? (poolSnap.data().status || 'active') : 'active',
        updatedAt: FieldValue.serverTimestamp(),
      }, { merge: true });

      tx.set(ledger().doc(entryId), {
        type: 'funding',
        pool: POOL_ID,
        source,
        direction: 'credit',
        amount,
        reference: reference || null,
        adminActor: 'admin',
        createdAt: FieldValue.serverTimestamp(),
        idempotencyKey: key,
      });

      tx.create(idem, {
        success: true,
        entryId,
        amount,
        source,
        reference: reference || null,
        createdAt: FieldValue.serverTimestamp(),
      });
    });

    res.json({ success: true, entryId, amount, source });
  } catch (error) {
    res.status(400).json({ error: error.message || 'Funding failed' });
  }
});

// Single reward path. Both the new page and the legacy flagged-referral
// approval endpoint use this function, so approval cannot bypass the pool.
router.post('/api/admin/referrals/:referralId/reward', requireAdmin, async (req, res) => {
  try {
    const result = await payReferralReward(req.params.referralId);
    res.json({ success: true, ...result });
  } catch (error) {
    res.status(400).json({ error: error.message || 'Reward payment failed' });
  }
});

// This route is mounted before routes/admin.js. It deliberately owns the
// old PATCH endpoint so the legacy Approve button cannot credit users
// without first debiting the Referral Pool.
router.patch('/api/admin/referrals/:referralId', requireAdmin, async (req, res) => {
  const action = clean(req.body?.action).toLowerCase();
  if (!['approve', 'deny'].includes(action)) {
    return res.status(400).json({ success: false, error: 'Action must be approve or deny' });
  }

  const referralRef = db.collection('referrals').doc(req.params.referralId);
  const snap = await referralRef.get();
  if (!snap.exists) return res.status(404).json({ success: false, error: 'Referral not found' });

  if (action === 'deny') {
    await referralRef.update({
      status: 'denied',
      rewardStatus: 'denied',
      resolvedAt: FieldValue.serverTimestamp(),
    });
    return res.json({ success: true, action: 'deny', paid: 0 });
  }

  try {
    const result = await payReferralReward(req.params.referralId);
    res.json({ success: true, action: 'approve', ...result });
  } catch (error) {
    res.status(400).json({ success: false, error: error.message || 'Referral approval failed' });
  }
});

export default router;
