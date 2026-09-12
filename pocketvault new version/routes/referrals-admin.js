import express from 'express';
import { db, FieldValue } from '../core/firebase.js';
import { requireAdmin, asyncHandler } from '../core/middleware.js';

const router = express.Router();
const POOL_ID = 'referral';
const BONUS = 500;
const LIFETIME_CAP = 10;

const poolRef = () => db.collection('platform_pools').doc(POOL_ID);
const clean = v => String(v ?? '').trim().slice(0, 160);
const money = v => Math.max(0, Math.round(Number(v) || 0));

async function getPool() {
  const snap = await poolRef().get();
  return snap.exists ? { id: snap.id, ...snap.data() } : { id: POOL_ID, availableBalance: 0, totalFunded: 0, totalPaid: 0, pendingRewards: 0, status: 'active' };
}

router.get('/api/admin/referrals/overview', requireAdmin, asyncHandler(async (req, res) => {
  const [pool, refsSnap] = await Promise.all([
    getPool(),
    db.collection('referrals').limit(1000).get()
  ]);
  const refs = refsSnap.docs.map(d => ({ id: d.id, ...d.data() }));
  const uids = [...new Set(refs.flatMap(r => [r.referrerUid, r.referredUid]).filter(Boolean))].slice(0, 400);
  const users = new Map();
  for (const uid of uids) { const s = await db.collection('users').doc(uid).get(); if (s.exists) users.set(uid, s.data() || {}); }
  const rows = refs.map(r => {
    const referred = users.get(r.referredUid) || {};
    return {
      referralId: r.id, referrerUid: r.referrerUid || null, referredUid: r.referredUid || null,
      referrerEmail: users.get(r.referrerUid)?.email || r.referrerEmail || r.referrerUid || '—',
      referredEmail: referred.email || r.referredEmail || r.referredUid || '—',
      kycStatus: referred.kycStatus || 'unverified',
      firstSave: Boolean(r.firstSaveAt || r.completedAt || referred.firstSaveAt),
      status: r.status || 'pending', rewardStatus: r.rewardStatus || 'pending',
      rewardTotal: r.rewardTotal ?? (BONUS * 2)
    };
  });
  res.json({ success: true, pool, rewardAmount: BONUS, lifetimeCap: LIFETIME_CAP, pendingRewards: rows.filter(r => r.rewardStatus !== 'paid' && r.status !== 'capped').length, totalReferrals: rows.length, referrals: rows });
}));

router.get('/api/admin/referrals/pool/ledger', requireAdmin, asyncHandler(async (req, res) => {
  const limit = Math.min(500, Math.max(1, Number(req.query.limit) || 100));
  const snap = await db.collection('platform_pool_ledger').where('poolId', '==', POOL_ID).limit(limit).get();
  const ledger = snap.docs.map(d => ({ id: d.id, ...d.data() })).sort((a,b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')));
  res.json({ success: true, ledger });
}));

router.post('/api/admin/referrals/pool/fund', requireAdmin, asyncHandler(async (req, res) => {
  const source = clean(req.body?.source).toLowerCase();
  const amount = money(req.body?.amount);
  const reference = clean(req.body?.reference);
  if (!['main_pool', 'airtel'].includes(source)) return res.status(400).json({ error: 'Funding source must be main_pool or airtel.' });
  if (amount <= 0) return res.status(400).json({ error: 'Funding amount must be greater than zero.' });
  if (source === 'airtel' && !reference) return res.status(400).json({ error: 'A confirmed Airtel transaction reference is required.' });
  const idempotency = `${source}:${reference || `manual-${Date.now()}`}`;
  const idemRef = db.collection('platform_pool_idempotency').doc(idempotency.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 140));
  const result = await db.runTransaction(async tx => {
    const idem = await tx.get(idemRef);
    if (idem.exists) return { duplicate: true, ledgerId: idem.data().ledgerId };
    const poolSnap = await tx.get(poolRef());
    const current = poolSnap.exists ? poolSnap.data() : {};
    if (source === 'main_pool') {
      const mainDocId = process.env.REFERRAL_MAIN_POOL_DOC;
      if (!mainDocId) throw Object.assign(new Error('REFERRAL_MAIN_POOL_DOC is not configured.'), { statusCode: 500 });
      const mainRef = db.collection('platform_pools').doc(mainDocId);
      const mainSnap = await tx.get(mainRef);
      const mainBalance = Number(mainSnap.data()?.availableBalance ?? mainSnap.data()?.balance ?? 0);
      if (mainBalance < amount) throw Object.assign(new Error('Main Pool does not have enough available balance.'), { statusCode: 400 });
      tx.update(mainRef, { availableBalance: FieldValue.increment(-amount), balance: FieldValue.increment(-amount), updatedAt: FieldValue.serverTimestamp() });
    }
    const ledgerRef = db.collection('platform_pool_ledger').doc();
    tx.set(poolRef(), { availableBalance: FieldValue.increment(amount), totalFunded: FieldValue.increment(amount), updatedAt: FieldValue.serverTimestamp(), status: 'active' }, { merge: true });
    tx.set(ledgerRef, { poolId: POOL_ID, type: 'funding', source, amount, reference: reference || null, createdAt: FieldValue.serverTimestamp() });
    tx.set(idemRef, { ledgerId: ledgerRef.id, createdAt: FieldValue.serverTimestamp() });
    return { duplicate: false, ledgerId: ledgerRef.id };
  });
  res.json({ success: true, ...result });
}));

router.post('/api/admin/referrals/:referralId/reward', requireAdmin, asyncHandler(async (req, res) => {
  const referralId = clean(req.params.referralId);
  const refRef = db.collection('referrals').doc(referralId);
  const result = await db.runTransaction(async tx => {
    const refSnap = await tx.get(refRef);
    if (!refSnap.exists) throw Object.assign(new Error('Referral not found.'), { statusCode: 404 });
    const referral = refSnap.data() || {};
    if (referral.rewardStatus === 'paid') return { duplicate: true, ledgerId: referral.rewardLedgerId || null };
    const referredRef = db.collection('users').doc(referral.referredUid);
    const referrerRef = db.collection('users').doc(referral.referrerUid);
    const [referredSnap, referrerSnap, poolSnap] = await Promise.all([tx.get(referredRef), tx.get(referrerRef), tx.get(poolRef())]);
    const referred = referredSnap.data() || {}; const referrer = referrerSnap.data() || {};
    const verified = ['verified', 'mock_verified'].includes(referred.kycStatus);
    const firstSave = Boolean(referral.firstSaveAt || referred.firstSaveAt);
    if (!verified) throw Object.assign(new Error('Referred user has not completed KYC.'), { statusCode: 400 });
    if (!firstSave) throw Object.assign(new Error('Referral is not eligible yet: first real save is missing.'), { statusCode: 400 });
    if ((referrer.referralCount || 0) >= LIFETIME_CAP) throw Object.assign(new Error('Referrer has reached the lifetime referral cap.'), { statusCode: 400 });
    const available = Number(poolSnap.data()?.availableBalance || 0);
    const total = BONUS * 2;
    if (available < total) throw Object.assign(new Error(`Referral Pool has insufficient funds. Need ${total}, available ${available}.`), { statusCode: 400 });
    const ledgerRef = db.collection('platform_pool_ledger').doc();
    tx.update(poolRef(), { availableBalance: FieldValue.increment(-total), totalPaid: FieldValue.increment(total), updatedAt: FieldValue.serverTimestamp() });
    tx.set(ledgerRef, { poolId: POOL_ID, type: 'reward', referralId, amount: total, referrerUid: referral.referrerUid, referredUid: referral.referredUid, createdAt: FieldValue.serverTimestamp() });
    tx.set(referrerRef, { accountBalance: FieldValue.increment(BONUS), referralCount: FieldValue.increment(1) }, { merge: true });
    tx.set(referredRef, { accountBalance: FieldValue.increment(BONUS) }, { merge: true });
    tx.update(refRef, { status: 'completed', rewardStatus: 'paid', rewardAmount: BONUS, rewardTotal: total, rewardLedgerId: ledgerRef.id, completedAt: FieldValue.serverTimestamp(), paidAt: FieldValue.serverTimestamp() });
    return { duplicate: false, ledgerId: ledgerRef.id, amount: total };
  });
  res.json({ success: true, ...result });
}));

export default router;
