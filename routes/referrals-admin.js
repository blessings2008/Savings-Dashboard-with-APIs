import express from 'express';
import crypto from 'crypto';
import { db, FieldValue } from '../core/firebase.js';
import { requireAdmin } from '../core/middleware.js';

const router = express.Router();
const POOL_ID = 'referral';
const poolRef = () => db.collection('platform_pools').doc(POOL_ID);
const ledger = () => db.collection('platform_pool_ledger');
const idemRef = key => db.collection('platform_pool_idempotency').doc(crypto.createHash('sha256').update(String(key)).digest('hex'));
function num(v) { const n = Number(v); return Number.isFinite(n) ? n : 0; }
function clean(v) { return typeof v === 'string' ? v.trim().slice(0, 200) : ''; }

async function getPool() {
  const snap = await poolRef().get();
  return snap.exists ? snap.data() : { availableBalance: 0, totalFunded: 0, totalPaid: 0, pendingRewards: 0, status: 'active' };
}

router.get('/api/admin/referrals/overview', requireAdmin, async (req, res) => {
  const [pool, referralSnap] = await Promise.all([getPool(), db.collection('referrals').orderBy('createdAt', 'desc').limit(1000).get().catch(() => db.collection('referrals').limit(1000).get())]);
  const referrals = referralSnap.docs.map(d => ({ id: d.id, ...d.data() }));
  const participantUids = new Set();
  referrals.forEach(r => { if (r.referrerUid) participantUids.add(r.referrerUid); if (r.referredUid || r.referredUserUid || r.uid) participantUids.add(r.referredUid || r.referredUserUid || r.uid); });
  const users = {};
  await Promise.all([...participantUids].slice(0, 400).map(async uid => { try { const s = await db.collection('users').doc(uid).get(); if (s.exists) users[uid] = s.data(); } catch {} }));
  const rows = referrals.map(r => {
    const referredUid = r.referredUid || r.referredUserUid || r.uid;
    const ru = users[referredUid] || {}; const fu = users[r.referrerUid] || {};
    return { id:r.id, referrerName:fu.name||fu.displayName||fu.email||r.referrerUid, referredName:ru.name||ru.displayName||ru.email||referredUid, referrerEmail:fu.email||'', referredEmail:ru.email||'', kycStatus:r.kycStatus||ru.kycStatus||(ru.kycVerified?'verified':'pending'), firstSave:Boolean(r.firstSave||r.firstSaveConfirmed||r.firstRealSave||r.completed), eligible:Boolean(r.eligible||r.rewardEligible||r.status==='eligible'||r.status==='completed'), rewardAmount:num(r.rewardAmount||500), rewardStatus:r.rewardStatus||r.rewardState||r.status||'pending', flagged:Boolean(r.flagged||r.reviewRequired||r.abuseFlag) };
  });
  const pendingRewards = rows.filter(r => r.eligible && !['paid','completed'].includes(String(r.rewardStatus).toLowerCase())).reduce((a,r) => a + r.rewardAmount * 2, 0);
  res.json({ pool:{availableBalance:num(pool.availableBalance),totalFunded:num(pool.totalFunded),totalPaid:num(pool.totalPaid),pendingRewards,status:pool.status||'active'}, settings:{rewardAmount:500}, enabled:pool.status!=='paused', stats:{totalParticipants:participantUids.size,totalReferrals:rows.length}, referrals:rows });
});

router.post('/api/admin/referrals/pool/fund', requireAdmin, async (req, res) => {
  const source=clean(req.body?.source), amount=num(req.body?.amount), reference=clean(req.body?.reference);
  const key=clean(req.get('Idempotency-Key'))||`${source}:${reference}:${amount}`;
  if(!['main_pool','airtel'].includes(source)) return res.status(400).json({error:'Invalid funding source'});
  if(!Number.isInteger(amount)||amount<=0) return res.status(400).json({error:'Amount must be a positive whole MWK amount'});
  if(source==='airtel'&&!reference) return res.status(400).json({error:'A confirmed Airtel transaction reference is required'});
  const idem=idemRef(key); if((await idem.get()).exists) return res.json({success:true,duplicate:true,...(await idem.get()).data()});
  if(source==='main_pool'&&!process.env.REFERRAL_MAIN_POOL_DOC) return res.status(409).json({error:'Main Pool transfer is not configured. Set REFERRAL_MAIN_POOL_DOC to the existing Main Pool document.'});
  const pool=poolRef(), main=source==='main_pool'?db.collection('platform_pools').doc(process.env.REFERRAL_MAIN_POOL_DOC):null;
  const entryId=`fund_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
  try { await db.runTransaction(async tx=>{ const p=await tx.get(pool), current=p.exists?num(p.data().availableBalance):0; if(main){const m=await tx.get(main);if(!m.exists)throw new Error('Configured Main Pool does not exist');const balance=num(m.data().availableBalance??m.data().balance);if(balance<amount)throw new Error('Main Pool has insufficient available balance');tx.update(main,{availableBalance:balance-amount,balance:balance-amount,updatedAt:FieldValue.serverTimestamp()});} tx.set(pool,{availableBalance:current+amount,totalFunded:num(p.exists?p.data().totalFunded:0)+amount,status:p.exists?(p.data().status||'active'):'active',updatedAt:FieldValue.serverTimestamp()},{merge:true});tx.set(ledger().doc(entryId),{type:'funding',pool:POOL_ID,source,direction:'credit',amount,reference:reference||null,adminActor:'admin',createdAt:FieldValue.serverTimestamp(),idempotencyKey:key});tx.create(idem,{success:true,entryId,amount,source,reference:reference||null,createdAt:FieldValue.serverTimestamp()});}); res.json({success:true,entryId,amount,source}); } catch(e){res.status(400).json({error:e.message||'Funding failed'});}
});

router.post('/api/admin/referrals/:referralId/reward', requireAdmin, async (req,res) => {
  const referralRef=db.collection('referrals').doc(req.params.referralId); const snap=await referralRef.get();
  if(!snap.exists)return res.status(404).json({error:'Referral not found'});
  const r=snap.data(); if(r.rewardStatus==='paid')return res.json({success:true,alreadyPaid:true});
  if(!['completed','flagged_review','eligible'].includes(r.status)&&!r.eligible&&!r.rewardEligible)return res.status(400).json({error:'Referral is not eligible for reward'});
  const referrer=r.referrerUid, referred=r.referredUid||r.referredUserUid||r.uid; if(!referrer||!referred)return res.status(400).json({error:'Referral participants are incomplete'});
  const each=num(r.bonusAmount||r.rewardAmount||500); if(!Number.isInteger(each)||each<=0)return res.status(400).json({error:'Invalid reward amount'});
  const total=each*2, idem=idemRef(`reward:${req.params.referralId}`);
  try { const result=await db.runTransaction(async tx=>{ const [p,i]=await Promise.all([tx.get(poolRef()),tx.get(idem)]); if(i.exists)return {duplicate:true,...i.data()}; const balance=p.exists?num(p.data().availableBalance):0;if(balance<total)throw new Error('Insufficient referral pool balance'); const next=balance-total;tx.set(poolRef(),{availableBalance:next,totalPaid:num(p.data().totalPaid)+total,updatedAt:FieldValue.serverTimestamp()},{merge:true});const entry=ledger().doc();tx.set(entry,{type:'reward',pool:POOL_ID,direction:'debit',amount:total,reference:req.params.referralId,referrerUid:referrer,referredUid:referred,createdAt:FieldValue.serverTimestamp(),idempotencyKey:`reward:${req.params.referralId}`});tx.set(idem,{success:true,paid:total,each,ledgerId:entry.id,createdAt:FieldValue.serverTimestamp()});tx.set(db.collection('users').doc(referrer),{accountBalance:FieldValue.increment(each),referralCount:FieldValue.increment(1)},{merge:true});tx.set(db.collection('users').doc(referred),{accountBalance:FieldValue.increment(each)},{merge:true});tx.set(referralRef,{rewardStatus:'paid',rewardPaidAt:FieldValue.serverTimestamp(),rewardPoolLedgerId:entry.id,status:'completed',completedAt:FieldValue.serverTimestamp()},{merge:true});return {paid:total,each,ledgerId:entry.id}; }); res.json({success:true,...result}); } catch(e){res.status(400).json({error:e.message||'Reward payment failed'});}
});

export default router;
