import express from 'express';
import { db, FieldValue } from '../core/firebase.js';
import { requireAdmin, asyncHandler } from '../core/middleware.js';
import { getReferralPool, fundReferralPool, debitReferralPool } from '../core/referral-pool.js';

const router = express.Router();

router.get('/api/admin/referrals/overview', requireAdmin, asyncHandler(async (req, res) => {
  const pool = await getReferralPool();
  const snap = await db.collection('referrals').limit(2000).get();
  const referrals = [];
  snap.forEach(doc => {
    const x = doc.data();
    referrals.push({
      id: doc.id,
      referrerUid: x.referrerUid, referredUid: x.referredUid,
      referrerName: x.referrerName, referredName: x.referredName,
      referrerEmail: x.referrerEmail, referredEmail: x.referredEmail,
      kycStatus: x.kycStatus || x.referredKycStatus || 'pending',
      firstSave: Boolean(x.firstSave || x.firstSaveConfirmed || x.firstRealSave),
      eligible: Boolean(x.eligible || x.status === 'completed' || x.status === 'flagged_review'),
      rewardAmount: Number(x.rewardAmount || x.bonusAmount || 500),
      rewardStatus: x.rewardStatus || (x.status === 'completed' ? 'pending' : x.status) || 'pending',
      flagged: x.status === 'flagged_review' || Boolean(x.flagged),
      createdAt: x.createdAt || null,
      completedAt: x.completedAt || null
    });
  });
  referrals.sort((a,b) => {
    const am = a.createdAt?._seconds ? a.createdAt._seconds : new Date(a.createdAt || 0).getTime()/1000;
    const bm = b.createdAt?._seconds ? b.createdAt._seconds : new Date(b.createdAt || 0).getTime()/1000;
    return bm - am;
  });
  res.json({
    success: true,
    pool: {
      availableBalance: Number(pool.availableBalance || 0),
      totalFunded: Number(pool.totalFunded || 0),
      totalPaid: Number(pool.totalPaid || 0),
      pendingRewards: Number(pool.pendingRewards || 0),
      status: pool.status || 'active'
    },
    stats: { totalParticipants: referrals.length },
    settings: { rewardAmount: 500 },
    enabled: (pool.status || 'active') !== 'paused',
    referrals
  });
}));

router.post('/api/admin/referrals/pool/fund', requireAdmin, asyncHandler(async (req, res) => {
  const source = String(req.body?.source || '');
  const amount = Number(req.body?.amount);
  const reference = String(req.body?.reference || '').trim();
  const idempotencyKey = String(req.headers['idempotency-key'] || '').trim();
  if (!Number.isInteger(amount) || amount <= 0) return res.status(400).json({success:false,error:'Amount must be a positive whole number'});
  if (!idempotencyKey) return res.status(400).json({success:false,error:'Idempotency-Key header is required'});
  if (source === 'airtel' && !reference) return res.status(400).json({success:false,error:'Confirmed Airtel transaction reference is required'});
  if (!['main_pool','airtel'].includes(source)) return res.status(400).json({success:false,error:'Invalid funding source'});
  const result = await fundReferralPool({ source, amount, reference, actor:'admin', idempotencyKey });
  res.json({success:true,result});
}));

router.post('/api/admin/referrals/:referralId/reward', requireAdmin, asyncHandler(async (req,res) => {
  const ref = db.collection('referrals').doc(req.params.referralId);
  const snap = await ref.get();
  if (!snap.exists) return res.status(404).json({success:false,error:'Referral not found'});
  const referral = snap.data();
  if (referral.rewardStatus === 'paid') return res.json({success:true,alreadyPaid:true});
  if (!['completed','flagged_review'].includes(referral.status) && !referral.eligible) return res.status(400).json({success:false,error:'Referral is not eligible for reward'});
  if (!referral.referrerUid || !referral.referredUid) return res.status(400).json({success:false,error:'Referral participants are incomplete'});

  const bonus = Number(referral.bonusAmount || referral.rewardAmount || 500);
  if (!Number.isInteger(bonus) || bonus <= 0) return res.status(400).json({success:false,error:'Invalid reward amount'});
  const total = bonus * 2;
  const debit = await debitReferralPool({
    amount: total,
    reference: req.params.referralId,
    actor: 'admin',
    reason: 'referral_reward',
    idempotencyKey: `referral-reward-${req.params.referralId}`
  });

  const batch = db.batch();
  batch.set(db.collection('users').doc(referral.referrerUid), { accountBalance: FieldValue.increment(bonus), referralCount: FieldValue.increment(1) }, {merge:true});
  batch.set(db.collection('users').doc(referral.referredUid), { accountBalance: FieldValue.increment(bonus) }, {merge:true});
  batch.set(ref, { rewardStatus:'paid', rewardPaidAt:FieldValue.serverTimestamp(), rewardPoolLedgerId:debit.id, status:'completed', completedAt:FieldValue.serverTimestamp() }, {merge:true});
  await batch.commit();
  res.json({success:true, paid:total, each:bonus, ledgerId:debit.id});
}));

export default router;
