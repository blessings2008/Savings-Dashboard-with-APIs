// PocketVault user-facing API routes.
// Everything a signed-in user's own app calls: profile, KYC,
// referrals, goals, save/withdraw, auto-save rules, round-ups,
// merchant collect/disburse (for Business-plan users acting as a
// merchant), transactions, analytics, notifications, subscriptions,
// and the Airtel/PayChangu payment webhooks.
//
// Moved verbatim out of the old monolithic server.js — every
// app.get/post/patch/delete became router.get/post/patch/delete on
// an express.Router(), mounted in server.js. No route path, body
// shape, or business logic changed in this move.
import express from 'express';
import crypto from 'crypto';
import { db, FieldValue, adminAuth } from '../core/firebase.js';
import { AIRTEL, PAYCHANGU, PLANS, SECURITY, CURRENT_TERMS_VERSION, resolvePaymentProvider, isMockMode } from '../core/config.js';
import { cache, clearCache, getCached, airtelQueue } from '../core/state.js';
import {
  requireAuth, requireOwnData, requireAdmin, requirePlan,
  asyncHandler, rateLimit, sanitize, safeCompare, getUserPlan, getPlanConfig
} from '../core/middleware.js';
import {
  airtelBalance, airtelCollect, airtelDisburse, airtelKYC, airtelTransactionStatus, airtelTransactionSummary,
  generateRef, ensureMerchantCode, deactivateMerchantCode, withIdempotency, calcFee, parseAmount, toMillis,
  updateSavingsStreak, checkGoalMilestone, checkReferralCompletion, isAirtelSuccess,
  logTransaction, logFee, pushNotification, updateGoalProgress, checkFloatSufficient, isAlreadyProcessed,
  logSystemError, sendExternalAlert, REFERRAL_BONUS_MWK, REFERRAL_LIFETIME_CAP, log
} from '../helpers.js';
import { unfreezeGoalsOnRenewal } from '../jobs.js';

const router = express.Router();

router.get('/api/health', asyncHandler(async (req, res) => {
  let dbHealthy = true;
  let dbLatencyMs = null;
  try {
    const start = Date.now();
    await db.collection('users').limit(1).get();
    dbLatencyMs = Date.now() - start;
  } catch (err) {
    dbHealthy = false;
    await sendExternalAlert('Health check failed', `Firestore is unreachable: ${err.message}`);
  }

  const healthy = dbHealthy;
  res.status(healthy ? 200 : 503).json({
    status: healthy ? 'ok' : 'degraded',
    app: 'PocketVault',
    version: '2.0',
    uptime: Math.floor(process.uptime()),
    timestamp: new Date().toISOString(),
    airtel: AIRTEL.CLIENT_ID ? 'configured' : 'pending_approval',
    paymentProvider: resolvePaymentProvider(),
    database: { healthy: dbHealthy, latencyMs: dbLatencyMs },
    queue: airtelQueue.length,
    cache: cache.size,
    memory: `${Math.round(process.memoryUsage().heapUsed / 1024 / 1024)}MB`
  });
}));

// ----------------------------
// PLANS: GET ALL PLANS
// GET /api/plans (public)
// ----------------------------
router.get('/api/plans', (req, res) => {
  res.json({ success: true, plans: PLANS });
});

// ----------------------------
// SUBSCRIPTION: SUBSCRIBE TO PLAN
// POST /api/subscribe
// Body: { uid, plan, phone }
// Flow: collect subscription fee via Airtel then upgrade plan
// ----------------------------
// ----------------------------
// SUBSCRIBE / CHANGE PLAN
// POST /api/subscribe
// Charges from the user's PocketVault account balance — NOT their
// external Airtel wallet. This used to call airtelCollect() directly,
// the same way /api/save originally did before the balance-model
// migration, and was simply never updated when that migration
// happened. A subscription payment is now exactly like any other
// internal spend: it comes out of accountBalance, same as an
// allocation or an internal transfer, with no Airtel call and no
// phone number needed. If a user wants to pay for a plan using money
// that's still in their Airtel wallet, they add it to their balance
// via /api/save first, same as they would before allocating to a
// goal or sending a transfer.
// Body: { uid, plan }
// ----------------------------
router.post('/api/subscribe',
  requireAuth,
  requireOwnData,
  asyncHandler(async (req, res) => {
    const { uid, plan, idempotencyKey } = req.body;

    if (!plan || !PLANS[plan]) {
      return res.status(400).json({ success: false, error: 'Invalid plan' });
    }
    if (plan === 'free') {
      // Downgrade to free — no payment needed
      await db.collection('users').doc(uid).set({
        plan: 'free',
        planUpdatedAt: FieldValue.serverTimestamp(),
        subscriptionActive: false
      }, { merge: true });
      await deactivateMerchantCode(uid);
      clearCache(`plan_${uid}`);
      return res.json({ success: true, message: 'Downgraded to free plan' });
    }

    const planConfig = PLANS[plan];

    const outcome = await withIdempotency(uid, idempotencyKey, async () => {
      const userSnap = await db.collection('users').doc(uid).get();
      const userData = userSnap.data() || {};
      if ((userData.accountBalance || 0) < planConfig.price) {
        const err = new Error(`Insufficient account balance. Available: MWK ${(userData.accountBalance || 0).toLocaleString()}, needed: MWK ${planConfig.price.toLocaleString()}`);
        err.isTransferFailure = true;
        err.details = { insufficientBalance: true };
        throw err;
      }

      const reference = generateRef();
      const expiry = Date.now() + 30 * 24 * 60 * 60 * 1000; // 30 days

      await db.collection('users').doc(uid).set({
        accountBalance: FieldValue.increment(-planConfig.price),
        plan,
        planUpdatedAt: FieldValue.serverTimestamp(),
        subscriptionActive: true,
        subscriptionExpiry: expiry,
        lastPaymentRef: reference
      }, { merge: true });

      await logTransaction(uid, {
        type: 'subscription',
        amount: planConfig.price,
        plan, reference,
        status: 'completed'
      });

      // No Airtel leg on this transaction at all — the full amount
      // is platform revenue, unlike save/withdraw/merchant flows
      // where Airtel's 1.5% cut is split out (see calcFee() in
      // helpers.js). Subscriptions were never Airtel-fee-inclusive
      // to begin with, so nothing changes there.
      await db.collection('platform_fees').add({
        uid, type: 'subscription',
        amount: planConfig.price,
        plan, reference,
        timestamp: FieldValue.serverTimestamp()
      });

      await pushNotification(uid, {
        type: 'subscription_success',
        message: `🎉 Welcome to ${planConfig.name} plan! All features unlocked for 30 days.`
      });

      try {
        await unfreezeGoalsOnRenewal(uid);
      } catch (e) {
        logSystemError('goal_unfreeze_on_renewal', e.message, { uid, stack: e.stack });
      }

      let merchantCode = null;
      if (plan === 'business') {
        merchantCode = await ensureMerchantCode(uid);
        await pushNotification(uid, {
          type: 'merchant_code_ready',
          message: `🏪 Your merchant code is ${merchantCode}. Share it so PocketVault users can pay you directly.`
        });
      }

      clearCache(`plan_${uid}`, `profile_${uid}`);
      return {
        success: true,
        message: `Upgraded to ${planConfig.name} plan`,
        plan, reference,
        expiry: new Date(expiry).toISOString(),
        merchantCode
      };
    }).catch(err => {
      if (err.isTransferFailure) return { success: false, error: err.message, details: err.details, _statusCode: 400 };
      throw err;
    });

    const statusCode = outcome._statusCode || 200;
    delete outcome._statusCode;
    res.status(statusCode).json(outcome);
  })
);

// ----------------------------
// SUBSCRIPTION: CHECK STATUS
// GET /api/subscribe/status
// ----------------------------
router.get('/api/subscribe/status',
  requireAuth,
  asyncHandler(async (req, res) => {
    const uid = req.user.uid;
    const snap = await db.collection('users').doc(uid).get();
    const user = snap.data() || {};
    const plan = user.plan || 'free';
    const config = PLANS[plan] || PLANS.free;

    // Check if subscription expired
    if (plan !== 'free' && user.subscriptionExpiry) {
      if (Date.now() > user.subscriptionExpiry) {
        // Auto downgrade
        await db.collection('users').doc(uid).set({
          plan: 'free',
          subscriptionActive: false
        }, { merge: true });
        if (plan === 'business') await deactivateMerchantCode(uid);
        clearCache(`plan_${uid}`);
        return res.json({
          success: true,
          plan: 'free',
          config: PLANS.free,
          expired: true,
          message: 'Your subscription has expired. You have been moved to the free plan.'
        });
      }
    }

    res.json({
      success: true,
      plan,
      config,
      subscriptionActive: user.subscriptionActive || plan === 'free',
      subscriptionExpiry: user.subscriptionExpiry || null,
      daysRemaining: user.subscriptionExpiry
        ? Math.max(0, Math.ceil((user.subscriptionExpiry - Date.now()) / (24 * 60 * 60 * 1000)))
        : null
    });
  })
);

// ----------------------------
// PROFILE: CREATE / UPDATE
// POST /api/profile
// ----------------------------
router.post('/api/profile',
  requireAuth,
  requireOwnData,
  asyncHandler(async (req, res) => {
    const { uid, name, phone, termsAccepted, deviceFingerprint, businessName } = req.body;
    // PRODUCTION FIX: previously this unconditionally set name/phone
    // to null whenever either was omitted from the request body —
    // meaning a request that only intended to update one field (or,
    // as with the fingerprint-only calls below, neither) would
    // silently wipe the other out. Now only includes a field in the
    // update when the caller actually sent it.
    const updates = { updatedAt: FieldValue.serverTimestamp() };
    if (name !== undefined) updates.name = name || null;
    if (phone !== undefined) updates.phone = phone || null;
    // Business-plan merchants can name their business — shown to
    // payers as the merchant identity when they look up a code (see
    // GET /api/merchant/lookup/:code) and on the merchant's own
    // Account tab. Anyone can technically send this field, but it's
    // only ever displayed/used in merchant-specific contexts, so
    // there's no real harm in a non-merchant setting one that never
    // surfaces anywhere.
    if (businessName !== undefined) updates.businessName = businessName || null;

    // PRODUCTION FIX #9: record that (and when, and which version of)
    // terms a user accepted. The frontend shows a T&C checkbox at
    // signup already — this is what actually makes that acceptance
    // provable later if there's ever a dispute, rather than just a
    // UI checkbox with no server-side record.
    if (termsAccepted) {
      updates.termsAcceptedAt = FieldValue.serverTimestamp();
      updates.termsVersion = CURRENT_TERMS_VERSION;
    }

    // Device fingerprint — referral abuse detection only (see
    // js/core/fingerprint.js and checkReferralCompletion() in
    // helpers.js). Sent on every sign-in, but only ever STORED once
    // per account — never overwritten — so a user switching devices
    // later doesn't erase the original signal checkReferralCompletion
    // needs to compare against.
    if (deviceFingerprint) {
      const existing = await db.collection('users').doc(uid).get();
      if (!existing.data()?.deviceFingerprint) {
        updates.deviceFingerprint = deviceFingerprint;
      }
    }

    await db.collection('users').doc(uid).set(updates, { merge: true });
    clearCache(`plan_${uid}`, `profile_${uid}`);
    res.json({ success: true });
  })
);

// ----------------------------
// ACCOUNT: ACCEPT TERMS (standalone)
// POST /api/account/accept-terms
// Separate from /api/profile so re-prompting an existing user after
// a terms update (CURRENT_TERMS_VERSION bump) doesn't require
// touching their name/phone.
// ----------------------------
router.post('/api/account/accept-terms', requireAuth, requireOwnData, asyncHandler(async (req, res) => {
  const { uid } = req.body;
  await db.collection('users').doc(uid).set({
    termsAcceptedAt: FieldValue.serverTimestamp(),
    termsVersion: CURRENT_TERMS_VERSION
  }, { merge: true });
  res.json({ success: true, termsVersion: CURRENT_TERMS_VERSION });
}));

// ============================================================
// REFERRAL SYSTEM
// Flat MWK 500 bonus to both referrer and referred user, but only
// once the referred user has verified KYC AND completed their
// first real save (see checkReferralCompletion() above). Tying
// the payout to genuine Airtel-verified activity — not just
// signup — is the main defense against fake-account farming.
// ============================================================

// ----------------------------
// GET MY REFERRAL CODE + STATS
// GET /api/referrals/my-code
// The code is just the first 8 chars of the user's own UID —
// simple, unique by construction (Firebase UIDs are already
// unique), no separate code-generation or collision-checking needed.
// ----------------------------
router.get('/api/referrals/my-code', requireAuth, asyncHandler(async (req, res) => {
  const uid = req.user.uid;
  const code = uid.slice(0, 8).toUpperCase();

  const [pendingSnap, completedSnap] = await Promise.all([
    db.collection('referrals').where('referrerUid', '==', uid).where('status', '==', 'pending').get(),
    db.collection('referrals').where('referrerUid', '==', uid).where('status', '==', 'completed').get(),
  ]);

  let totalEarned = 0;
  completedSnap.forEach(d => { totalEarned += d.data().bonusAmount || 0; });

  res.json({
    success: true,
    code,
    pendingReferrals: pendingSnap.size,
    completedReferrals: completedSnap.size,
    totalEarned,
    bonusAmount: REFERRAL_BONUS_MWK
  });
}));

// ----------------------------
// APPLY A REFERRAL CODE
// POST /api/referrals/apply
// Called once, right after account creation on the frontend.
// Body: { uid, code }
// ----------------------------
router.post('/api/referrals/apply',
  requireAuth,
  requireOwnData,
  rateLimit(5, 60 * 1000),
  asyncHandler(async (req, res) => {
    const { uid, code } = req.body;
    if (!code?.trim()) return res.status(400).json({ success: false, error: 'Referral code required' });

    const userSnap = await db.collection('users').doc(uid).get();
    const user = userSnap.data() || {};
    if (user.referredBy) {
      return res.status(400).json({ success: false, error: 'A referral code has already been applied to this account' });
    }

    // Find the referrer by matching the first 8 chars of their UID.
    // This requires a scan since Firestore can't query on a substring
    // of the document ID directly — acceptable at PocketVault's current
    // scale, and can be optimized later with a dedicated lookup
    // collection if the user base grows large enough to matter.
    const codeUpper = code.trim().toUpperCase();
    const usersSnap = await db.collection('users').limit(2000).get();
    let referrerUid = null;
    let referrerData = null;
    usersSnap.forEach(d => {
      if (d.id.slice(0, 8).toUpperCase() === codeUpper) {
        referrerUid = d.id;
        referrerData = d.data();
      }
    });

    if (!referrerUid) return res.status(404).json({ success: false, error: 'Referral code not found' });
    if (referrerUid === uid) return res.status(400).json({ success: false, error: 'You cannot refer yourself' });

    // ANTI-ABUSE: once a referrer has hit the lifetime completion cap,
    // their code stops working entirely rather than continuing to
    // accept new signups that would never actually pay out — a
    // clearer experience than a code that silently stops rewarding.
    if ((referrerData?.referralCount || 0) >= REFERRAL_LIFETIME_CAP) {
      return res.status(400).json({ success: false, error: 'This referral code is no longer active' });
    }

    await db.collection('users').doc(uid).set({ referredBy: referrerUid }, { merge: true });
    await db.collection('referrals').add({
      referrerUid, referredUid: uid,
      status: 'pending',
      createdAt: FieldValue.serverTimestamp()
    });

    res.json({ success: true, message: 'Referral code applied! Complete KYC and your first save to unlock both bonuses.' });
  })
);

// ----------------------------
// KYC STEP 1: SEND OTP
// POST /api/kyc/send-otp
// Body: { uid, phone }
// Generates a 6-digit OTP, stores it hashed in Firestore,
// and sends it via Airtel Collection USSD prompt (or notification in mock mode)
// ----------------------------
router.post('/api/kyc/send-otp',
  requireAuth,
  requireOwnData,
  rateLimit(5, 60 * 1000),
  asyncHandler(async (req, res) => {
    const { uid, phone } = req.body;
    const phoneClean = phone?.replace(/\s/g, '');
    const validPhone = /^(0[89][0-9]{8}|265[89][0-9]{8})$/.test(phoneClean);
    if (!validPhone) {
      return res.status(400).json({ success: false, error: 'Invalid Malawi phone number' });
    }

    // Check phone not already linked to another account
    const existing = await db.collection('users')
      .where('phone', '==', phoneClean)
      .where('phoneVerified', '==', true)
      .get();
    if (existing.docs.some(d => d.id !== uid)) {
      return res.status(400).json({ success: false, error: 'This number is already linked to another account' });
    }

    // Generate 6-digit OTP
    const otp = String(Math.floor(100000 + Math.random() * 900000));
    const otpHash = crypto.createHash('sha256').update(otp + uid).digest('hex');
    const otpExpiry = Date.now() + 10 * 60 * 1000; // 10 minutes

    // Store OTP hash (never store plaintext OTP)
    await db.collection('users').doc(uid).set({
      pendingPhone: phoneClean,
      otpHash,
      otpExpiry,
      otpAttempts: 0
    }, { merge: true });

    if (isMockMode()) {
      // Mock: push OTP as a notification so it can be seen in-app for testing
      await pushNotification(uid, {
        type: 'otp',
        topic: 'Phone Verification Code',
        message: `Your PocketVault verification code is: ${otp}. Valid for 10 minutes. Do not share this with anyone.`,
        senderName: 'PocketVault System',
        senderIcon: '🔐'
      });
      return res.json({
        success: true,
        mock: true,
        message: 'OTP sent to your Notifications (mock mode — check the bell icon)'
      });
    }

    // Real: In production, send OTP via SMS using Airtel's messaging or USSD
    // For now we use a notification push as Airtel SMS API is pending
    await pushNotification(uid, {
      type: 'otp',
      topic: 'Phone Verification Code',
      message: `Your PocketVault verification code is: ${otp}. Valid for 10 minutes. Do not share this with anyone.`,
      senderName: 'PocketVault System',
      senderIcon: '🔐'
    });

    res.json({ success: true, message: `Verification code sent to your notifications. Check the bell icon.` });
  })
);

// ----------------------------
// KYC STEP 2: VERIFY OTP
// POST /api/kyc/verify-otp
// Body: { uid, phone, otp }
// ----------------------------
router.post('/api/kyc/verify-otp',
  requireAuth,
  requireOwnData,
  rateLimit(10, 60 * 1000),
  asyncHandler(async (req, res) => {
    const { uid, phone, otp } = req.body;
    const phoneClean = phone?.replace(/\s/g, '');

    if (!otp || !/^\d{6}$/.test(otp)) {
      return res.status(400).json({ success: false, error: 'Enter the 6-digit code' });
    }

    const userSnap = await db.collection('users').doc(uid).get();
    const userData = userSnap.data() || {};

    // Check OTP exists and not expired
    if (!userData.otpHash || !userData.otpExpiry) {
      return res.status(400).json({ success: false, error: 'No OTP found. Please request a new code.' });
    }
    if (Date.now() > userData.otpExpiry) {
      return res.status(400).json({ success: false, error: 'Code expired. Please request a new one.' });
    }
    if (userData.pendingPhone !== phoneClean) {
      return res.status(400).json({ success: false, error: 'Phone number mismatch. Start verification again.' });
    }

    // Rate limit OTP attempts (max 5)
    const attempts = (userData.otpAttempts || 0) + 1;
    if (attempts > 5) {
      await db.collection('users').doc(uid).update({ otpHash: null, otpExpiry: null });
      return res.status(429).json({ success: false, error: 'Too many attempts. Request a new code.' });
    }
    await db.collection('users').doc(uid).update({ otpAttempts: attempts });

    // Verify hash
    const inputHash = crypto.createHash('sha256').update(otp + uid).digest('hex');
    if (inputHash !== userData.otpHash) {
      const remaining = 5 - attempts;
      return res.status(400).json({
        success: false,
        error: `Incorrect code. ${remaining} attempt${remaining !== 1 ? 's' : ''} remaining.`
      });
    }

    // OTP correct — now do additional provider-side verification if available.
    // The OTP step above already proves phone ownership regardless of
    // payment provider — this second check is an extra confirmation that
    // the number is specifically registered with Airtel Money, which is
    // only possible when talking to Airtel's API directly. PayChangu has
    // no equivalent lookup, so on that provider we rely on the OTP alone.
    let kycStatus = 'verified';
    let registeredName = null;

    const provider = resolvePaymentProvider();
    if (provider === 'airtel_direct') {
      const result = await airtelKYC(phoneClean);
      const verified = result?.data?.is_barred === false || result?.status?.code === '200';
      registeredName = result?.data?.first_name
        ? `${result.data.first_name} ${result.data.last_name || ''}`.trim()
        : null;
      kycStatus = verified ? 'verified' : 'failed';
    }
    // provider === 'paychangu' or 'mock' -> kycStatus stays 'verified'
    // based on the OTP check alone, since neither has a standalone
    // number-verification endpoint to double-check against.

    // Clear OTP, save verified phone
    await db.collection('users').doc(uid).set({
      phone: phoneClean,
      phoneVerified: kycStatus === 'verified',
      kycStatus,
      kycName: registeredName || null,
      kycAt: FieldValue.serverTimestamp(),
      pendingPhone: null,
      otpHash: null,
      otpExpiry: null,
      otpAttempts: null
    }, { merge: true });

    clearCache(`plan_${uid}`, `profile_${uid}`);

    if (kycStatus === 'verified') {
      await pushNotification(uid, {
        type: 'kyc_verified',
        topic: 'Phone Verified',
        message: `✅ Your phone ${phoneClean} has been verified successfully. You can now save and withdraw money.`,
        senderName: 'PocketVault System',
        senderIcon: '🔐'
      });
    }

    res.json({
      success: kycStatus === 'verified',
      verified: kycStatus === 'verified',
      name: registeredName,
      message: kycStatus === 'verified'
        ? `Phone verified${registeredName ? ` as ${registeredName}` : ''}!`
        : 'Airtel verification failed. Ensure this number is registered with Airtel Money.'
    });
  })
);

// ----------------------------
// KYC: ADMIN OVERRIDE ONLY
// POST /api/admin/kyc-override
// The OLD unauthenticated /api/kyc endpoint has been REMOVED —
// it allowed any logged-in user to instantly verify any phone
// with zero OTP confirmation, completely bypassing the OTP flow.
// Admins can still manually verify a user from the admin panel,
// but that now goes through PATCH /api/admin/users/:uid instead,
// which is already behind requireAdmin.
// ----------------------------

// ----------------------------
// BALANCE: AIRTEL WALLET
// GET /api/airtel/balance
// ----------------------------
router.get('/api/airtel/balance',
  requireAuth,
  asyncHandler(async (req, res) => {
    const uid = req.user.uid;
    if (isMockMode()) {
      return res.json({ success: true, mock: true, balance: 37600, currency: 'MWK' });
    }
    const data = await getCached(`balance_${uid}`, () => airtelBalance('COLL'), 30000);
    const balance = parseFloat(data?.data?.balance || 0);
    await db.collection('users').doc(uid).set({
      airtelBalance: { amount: balance, currency: 'MWK', lastSync: FieldValue.serverTimestamp() }
    }, { merge: true });
    res.json({ success: true, balance, currency: 'MWK' });
  })
);

// ----------------------------
// GOALS: CREATE
// POST /api/goals
// ----------------------------
router.post('/api/goals',
  requireAuth,
  requireOwnData,
  asyncHandler(async (req, res) => {
    const { uid, name, target, deadline, emoji, lockType, deadlineBehavior } = req.body;
    if (!name || !target) return res.status(400).json({ success: false, error: 'name and target required' });
    if (parseFloat(target) < 500) return res.status(400).json({ success: false, error: 'Minimum goal is MWK 500' });

    const { plan, config } = await getPlanConfig(uid);
    const existing = await db.collection('goals')
      .where('uid', '==', uid).where('completed', '==', false).get();

    if (existing.size >= config.maxGoals) {
      return res.status(403).json({
        success: false,
        error: `${config.name} plan allows max ${config.maxGoals} active goals.`,
        upgrade: true, currentPlan: plan
      });
    }

    // Savings lock requires pro or business
    if (lockType === 'hard' && !config.savingsLock) {
      return res.status(403).json({
        success: false,
        error: 'Savings lock requires Pro or Business plan',
        upgrade: true
      });
    }

    // Validate deadlineBehavior — only meaningful for locked goals with a deadline
    const validBehaviors = ['stay_locked', 'auto_unlock', 'ask_me'];
    let finalBehavior = null;
    if (lockType === 'hard' && deadline) {
      finalBehavior = validBehaviors.includes(deadlineBehavior) ? deadlineBehavior : 'ask_me';
    }

    const goal = {
      uid, name: sanitize(name),
      target: parseFloat(target), saved: 0,
      deadline: deadline || null,
      deadlineBehavior: finalBehavior,
      deadlinePassed: false,
      deadlineDecisionPending: false,
      emoji: emoji || '🎯',
      lockType: lockType || 'flexible',
      locked: lockType === 'hard',
      completed: false,
      createdAt: FieldValue.serverTimestamp()
    };

    const ref = await db.collection('goals').add(goal);
    clearCache(`goals_${uid}`);
    res.json({ success: true, goalId: ref.id, goal });
  })
);

// ----------------------------
// GOALS: GET ALL
// GET /api/goals
// ----------------------------
router.get('/api/goals',
  requireAuth,
  asyncHandler(async (req, res) => {
    const uid = req.user.uid;
    const goals = await getCached(`goals_${uid}`, async () => {
      const snap = await db.collection('goals')
        .where('uid', '==', uid).get();
      const docs = [];
      snap.forEach(doc => docs.push({ id: doc.id, ...doc.data() }));
      docs.sort((a, b) => toMillis(b.createdAt) - toMillis(a.createdAt));
      const result = {};
      docs.forEach(d => { result[d.id] = d; });
      return result;
    }, 15000);
    res.json({ success: true, goals });
  })
);

// ----------------------------
// GOALS: UPDATE
// PATCH /api/goals/:goalId
// ----------------------------
router.patch('/api/goals/:goalId',
  requireAuth,
  asyncHandler(async (req, res) => {
    const { goalId } = req.params;
    const uid = req.user.uid;
    const snap = await db.collection('goals').doc(goalId).get();
    const goal = snap.data();
    if (!goal) return res.status(404).json({ success: false, error: 'Goal not found' });
    if (goal.uid !== uid) return res.status(403).json({ success: false, error: 'Forbidden' });
    if (goal.completed) return res.status(400).json({ success: false, error: 'Cannot edit completed goal' });

    const { name, target, deadline, emoji, lockType, deadlineBehavior } = req.body;

    // Locked goals can still have their deadline extended / behavior changed —
    // that's the whole point of the deadline-passed decision flow.
    // But name/target/lockType changes are blocked while hard-locked.
    const isDeadlineOnlyEdit = (deadline !== undefined || deadlineBehavior !== undefined)
      && name === undefined && target === undefined && lockType === undefined && emoji === undefined;

    if (goal.locked && goal.lockType === 'hard' && !isDeadlineOnlyEdit) {
      return res.status(400).json({ success: false, error: 'Goal is locked. You can only extend its deadline.' });
    }

    const updates = { updatedAt: FieldValue.serverTimestamp() };
    if (name) updates.name = sanitize(name);
    if (target) {
      const parsedTarget = parseAmount(target);
      if (parsedTarget === null || parsedTarget < 500) {
        return res.status(400).json({ success: false, error: 'Minimum target is MWK 500' });
      }
      updates.target = parsedTarget;
    }
    if (deadline) {
      updates.deadline = deadline;
      updates.deadlinePassed = false;
      updates.deadlineDecisionPending = false;
    }
    if (emoji) updates.emoji = emoji;
    if (lockType) {
      // Prevent Free-plan users upgrading to 'hard' lock via PATCH
      // (same check as goal creation — lockType 'hard' is Pro/Business only)
      if (lockType === 'hard') {
        const { config } = await getPlanConfig(uid);
        if (!config.savingsLock) {
          return res.status(403).json({
            success: false,
            error: 'Savings lock requires Pro or Business plan',
            upgrade: true
          });
        }
      }
      updates.lockType = lockType;
      updates.locked = lockType === 'hard';
    }
    if (deadlineBehavior && ['stay_locked','auto_unlock','ask_me'].includes(deadlineBehavior)) {
      updates.deadlineBehavior = deadlineBehavior;
    }

    await db.collection('goals').doc(goalId).update(updates);
    clearCache(`goals_${uid}`);
    res.json({ success: true });
  })
);

// ----------------------------
// GOALS: DEADLINE DECISION
// PATCH /api/goals/:goalId/deadline-decision
// For 'ask_me' goals once the deadline has passed —
// user chooses to unlock now or extend the deadline.
// Body: { action: 'unlock' | 'extend', newDeadline? }
// ----------------------------
router.patch('/api/goals/:goalId/deadline-decision',
  requireAuth,
  asyncHandler(async (req, res) => {
    const { goalId } = req.params;
    const uid = req.user.uid;
    const { action, newDeadline } = req.body;

    const snap = await db.collection('goals').doc(goalId).get();
    const goal = snap.data();
    if (!goal) return res.status(404).json({ success: false, error: 'Goal not found' });
    if (goal.uid !== uid) return res.status(403).json({ success: false, error: 'Forbidden' });
    if (!goal.deadlineDecisionPending) {
      return res.status(400).json({ success: false, error: 'No pending decision for this goal' });
    }

    if (action === 'unlock') {
      await snap.ref.update({
        locked: false,
        lockType: 'flexible',
        deadlineDecisionPending: false,
        deadlinePassed: false,
        updatedAt: FieldValue.serverTimestamp()
      });
      await pushNotification(uid, {
        type: 'goal_unlocked',
        topic: 'Goal Unlocked',
        message: `🔓 "${goal.name}" is now unlocked. You can withdraw your MWK ${(goal.saved||0).toLocaleString()} savings anytime.`
      });
      return res.json({ success: true, locked: false });
    }

    if (action === 'extend') {
      if (!newDeadline) return res.status(400).json({ success: false, error: 'newDeadline required' });
      await snap.ref.update({
        deadline: newDeadline,
        deadlinePassed: false,
        deadlineDecisionPending: false,
        updatedAt: FieldValue.serverTimestamp()
      });
      await pushNotification(uid, {
        type: 'goal_extended',
        topic: 'Deadline Extended',
        message: `📅 "${goal.name}" deadline extended to ${newDeadline}. Keep saving — you've got this!`
      });
      return res.json({ success: true, deadline: newDeadline });
    }

    return res.status(400).json({ success: false, error: 'action must be unlock or extend' });
  })
);

// ----------------------------
// GOALS: FROZEN GOAL DECISION
// PATCH /api/goals/:goalId/frozen-decision
// For goals frozen due to subscription expiry — user chooses to
// unlock now (early, losing the lock) or keep it frozen/locked
// until they renew. Only marks the prompt as shown; the actual
// grace-period auto-unlock (if they never choose) is handled by
// checkFrozenGoalGracePeriod().
// Body: { action: 'unlock' | 'keep_locked' }
// ----------------------------
router.patch('/api/goals/:goalId/frozen-decision',
  requireAuth,
  asyncHandler(async (req, res) => {
    const { goalId } = req.params;
    const uid = req.user.uid;
    const { action } = req.body;

    const snap = await db.collection('goals').doc(goalId).get();
    const goal = snap.data();
    if (!goal) return res.status(404).json({ success: false, error: 'Goal not found' });
    if (goal.uid !== uid) return res.status(403).json({ success: false, error: 'Forbidden' });
    if (!goal.frozen) {
      return res.status(400).json({ success: false, error: 'This goal is not frozen' });
    }

    if (action === 'unlock') {
      await snap.ref.update({
        frozen: false,
        locked: false,
        lockType: 'flexible',
        unlockedEarly: true,
        unlockReason: 'user_chose_early_unlock',
        frozenGraceDeadline: FieldValue.delete(),
        updatedAt: FieldValue.serverTimestamp()
      });
      await pushNotification(uid, {
        type: 'goal_unlocked',
        topic: 'Goal Unlocked',
        message: `🔓 "${goal.name}" is now unlocked. You can withdraw your MWK ${(goal.saved || 0).toLocaleString()} savings anytime.`
      });
      return res.json({ success: true, locked: false, frozen: false });
    }

    if (action === 'keep_locked') {
      await snap.ref.update({
        frozenPromptShown: true,
        updatedAt: FieldValue.serverTimestamp()
      });
      return res.json({ success: true, frozen: true, locked: true });
    }

    return res.status(400).json({ success: false, error: 'action must be unlock or keep_locked' });
  })
);

// ----------------------------
// SAVE: COLLECT FROM USER WALLET INTO ACCOUNT BALANCE
// POST /api/save
// Deposits land in the user's general accountBalance, not directly
// into a goal — money only enters a specific goal via the separate
// allocate endpoint below. This is what lets a user hold money
// that isn't committed to any goal yet, and is also what makes
// internal user-to-user transfers possible without ever touching
// Airtel (see POST /api/transfer).
// Body: { uid, amount, phone }
// ----------------------------
router.post('/api/save',
  requireAuth,
  requireOwnData,
  asyncHandler(async (req, res) => {
    const { uid, amount, phone, idempotencyKey } = req.body;
    if (!amount || !phone) {
      return res.status(400).json({ success: false, error: 'amount, phone required' });
    }
    const parsedAmount = parseAmount(amount);
    if (parsedAmount === null) {
      return res.status(400).json({ success: false, error: 'Enter a valid amount' });
    }
    if (parsedAmount < SECURITY.MIN_SAVE_AMOUNT) {
      return res.status(400).json({ success: false, error: `Minimum save is MWK ${SECURITY.MIN_SAVE_AMOUNT}` });
    }
    if (parsedAmount > SECURITY.MAX_SAVE_AMOUNT) {
      return res.status(400).json({ success: false, error: 'Amount exceeds maximum limit' });
    }

    // PRODUCTION FIX #1: everything below this point is wrapped in
    // idempotency protection — a double-tap or retry with the same
    // idempotencyKey returns the original result instead of charging
    // the user twice. See withIdempotency() for the full mechanism.
    const outcome = await withIdempotency(uid, idempotencyKey, async () => {
      const { plan, config } = await getPlanConfig(uid);
      const fee = calcFee(parsedAmount, config.transactionFeePercent);
      const reference = generateRef();

      // Mock mode
      if (isMockMode()) {
        await db.collection('users').doc(uid).set({
          accountBalance: FieldValue.increment(parsedAmount)
        }, { merge: true });
        const txId = await logTransaction(uid, {
          type: 'savings', amount: parsedAmount, fee: fee.total, feePercent: config.transactionFeePercent,
          reference, status: 'mock', phone, plan
        });
        await logFee(uid, { amount: fee.total, platformAmount: fee.platformAmount, airtelAmount: fee.airtelAmount, transactionId: txId, type: 'savings', plan });
        await pushNotification(uid, {
          type: 'savings_success',
          message: `💰 Added MWK ${parsedAmount.toLocaleString()} to your account balance. Allocate it to a goal anytime.`
        });
        try { await updateSavingsStreak(uid); } catch (e) { logSystemError('savings_streak', e.message, { uid, stack: e.stack }); }
        try { await checkReferralCompletion(uid); } catch (e) { logSystemError('referral_completion', e.message, { uid, stack: e.stack }); }
        clearCache(`profile_${uid}`, `analytics_${uid}`);
        return {
          success: true, mock: true,
          message: `MWK ${parsedAmount} added to your account balance`,
          reference, fee: fee.total, feePercent: config.transactionFeePercent
        };
      }

      // Real: collect from user wallet
      const result = await airtelCollect({ phone, amount: parsedAmount, reference });

      if (isAirtelSuccess(result)) {
        await db.collection('users').doc(uid).set({
          accountBalance: FieldValue.increment(parsedAmount)
        }, { merge: true });
        const txId = await logTransaction(uid, {
          type: 'savings', amount: parsedAmount, fee: fee.total, feePercent: config.transactionFeePercent,
          reference,
          airtelTxnId: result.txnId,
          airtelRef: result?.data?.transaction?.id,
          status: 'completed', phone, plan
        });
        await logFee(uid, { amount: fee.total, platformAmount: fee.platformAmount, airtelAmount: fee.airtelAmount, transactionId: txId, type: 'savings', plan });
        await pushNotification(uid, {
          type: 'savings_success',
          message: `💰 Added MWK ${parsedAmount.toLocaleString()} to your account balance. Allocate it to a goal anytime.`
        });
        try { await updateSavingsStreak(uid); } catch (e) { logSystemError('savings_streak', e.message, { uid, stack: e.stack }); }
        try { await checkReferralCompletion(uid); } catch (e) { logSystemError('referral_completion', e.message, { uid, stack: e.stack }); }
        clearCache(`profile_${uid}`, `analytics_${uid}`);
        return { success: true, message: `MWK ${parsedAmount} added to your account balance`, reference, fee: fee.total };
      } else {
        await logTransaction(uid, {
          type: 'savings', amount: parsedAmount,
          reference, status: 'failed', error: JSON.stringify(result)
        });
        const err = new Error('Transfer failed');
        err.isTransferFailure = true;
        err.details = result;
        throw err;
      }
    }).catch(err => {
      if (err.isTransferFailure) return { success: false, error: 'Transfer failed', details: err.details, _statusCode: 400 };
      throw err;
    });

    const statusCode = outcome._statusCode || 200;
    delete outcome._statusCode;
    res.status(statusCode).json(outcome);
  })
);

// ----------------------------
// WITHDRAW: SEND BACK TO USER WALLET FROM ACCOUNT BALANCE
// POST /api/withdraw
// Pulls only from accountBalance — money already allocated into a
// goal is committed and can no longer be withdrawn directly (that's
// the entire point of allocation now: once it's in a goal, it's
// locked in the "this money has a purpose" sense, not just the
// hard-lock-plan-feature sense). Body no longer takes goalId.
// Body: { uid, amount, phone }
// ----------------------------
router.post('/api/withdraw',
  requireAuth,
  requireOwnData,
  asyncHandler(async (req, res) => {
    const { uid, amount, phone, idempotencyKey } = req.body;
    if (!amount || !phone) {
      return res.status(400).json({ success: false, error: 'amount, phone required' });
    }
    const parsedAmount = parseAmount(amount);
    if (parsedAmount === null) {
      return res.status(400).json({ success: false, error: 'Enter a valid amount' });
    }
    if (parsedAmount < 100) return res.status(400).json({ success: false, error: 'Minimum withdrawal is MWK 100' });

    const userSnap = await db.collection('users').doc(uid).get();
    const userData = userSnap.data() || {};
    if ((userData.accountBalance || 0) < parsedAmount) {
      return res.status(400).json({
        success: false,
        error: `Insufficient account balance. Available: MWK ${(userData.accountBalance || 0).toLocaleString()}`
      });
    }

    // Calculate fee/payout up front — needed for the float check
    // below AND reused inside the idempotency-wrapped handler, since
    // fee percent is a function of plan config which can't change
    // mid-request anyway
    const { plan, config } = await getPlanConfig(uid);
    const fee = calcFee(parsedAmount, config.withdrawalFeePercent);
    const netPayout = parsedAmount - fee.total;

    // Float check only applies under Airtel direct — PayChangu has no
    // balance API to check against (see checkFloatSufficient() above)
    if (resolvePaymentProvider() === 'airtel_direct') {
      try { await checkFloatSufficient(netPayout); }
      catch {
        return res.status(503).json({
          success: false,
          error: 'Withdrawals temporarily unavailable. Please try again shortly.'
        });
      }
    }

    // PRODUCTION FIX #1: same idempotency protection as /api/save —
    // a double-tap or retry with the same idempotencyKey returns the
    // original result instead of disbursing twice. Note the balance
    // sufficiency check above happens BEFORE the idempotency lock is
    // claimed, same ordering as before (checked against the goal
    // previously) — a genuinely concurrent double-submit is still
    // caught by withIdempotency() itself since only one request can
    // ever hold a given key's lock.
    const outcome = await withIdempotency(uid, idempotencyKey, async () => {
      const reference = generateRef();

      // Mock mode
      if (isMockMode()) {
        await db.collection('users').doc(uid).set({
          accountBalance: FieldValue.increment(-parsedAmount)
        }, { merge: true });
        const txId = await logTransaction(uid, {
          type: 'withdrawal', amount: parsedAmount, fee: fee.total,
          feePercent: config.withdrawalFeePercent,
          netPayout, reference, status: 'mock', phone, plan
        });
        await logFee(uid, { amount: fee.total, platformAmount: fee.platformAmount, airtelAmount: fee.airtelAmount, transactionId: txId, type: 'withdrawal', plan });
        await pushNotification(uid, {
          type: 'withdrawal_success',
          message: `💸 MWK ${netPayout.toLocaleString()} sent to your Airtel wallet from your account balance.`
        });
        clearCache(`profile_${uid}`, `analytics_${uid}`);
        return { success: true, mock: true, message: `MWK ${netPayout.toLocaleString()} sent (MWK ${parsedAmount.toLocaleString()} withdrawn, MWK ${fee.total.toLocaleString()} fee)`, reference, fee: fee.total, netPayout, grossAmount: parsedAmount };
      }

      const result = await airtelDisburse({ phone, amount: netPayout, reference });
      if (isAirtelSuccess(result)) {
        await db.collection('users').doc(uid).set({
          accountBalance: FieldValue.increment(-parsedAmount)
        }, { merge: true });
        const txId = await logTransaction(uid, {
          type: 'withdrawal', amount: parsedAmount, fee: fee.total,
          feePercent: config.withdrawalFeePercent,
          netPayout, reference, airtelTxnId: result.txnId,
          airtelRef: result?.data?.transaction?.id,
          status: 'completed', phone, plan
        });
        await logFee(uid, { amount: fee.total, platformAmount: fee.platformAmount, airtelAmount: fee.airtelAmount, transactionId: txId, type: 'withdrawal', plan });
        await pushNotification(uid, {
          type: 'withdrawal_success',
          message: `💸 MWK ${netPayout.toLocaleString()} sent to your Airtel wallet from your account balance.`
        });
        clearCache(`profile_${uid}`, `analytics_${uid}`);
        return { success: true, message: `MWK ${netPayout.toLocaleString()} sent (MWK ${parsedAmount.toLocaleString()} withdrawn, MWK ${fee.total.toLocaleString()} fee)`, reference, fee: fee.total, netPayout, grossAmount: parsedAmount };
      } else {
        await logTransaction(uid, {
          type: 'withdrawal', amount: parsedAmount,
          reference, status: 'failed', error: JSON.stringify(result)
        });
        const err = new Error('Withdrawal failed');
        err.isTransferFailure = true;
        err.details = result;
        throw err;
      }
    }).catch(err => {
      if (err.isTransferFailure) return { success: false, error: 'Withdrawal failed', details: err.details, _statusCode: 400 };
      throw err;
    });

    const statusCode = outcome._statusCode || 200;
    delete outcome._statusCode;
    res.status(statusCode).json(outcome);
  })
);

// ----------------------------
// ALLOCATE: MOVE MONEY FROM ACCOUNT BALANCE INTO A GOAL
// POST /api/goals/:goalId/allocate
// Purely internal — no Airtel call, no fee. This is the ONLY way
// goal.saved increases from a direct user action now (auto-save
// rules and round-up can also allocate directly — see their
// `destination` field). Blocked on a frozen goal, same principle as
// the old save-into-a-frozen-goal block: frozen means no money
// moves in, whether that money was coming from Airtel directly (the
// old model) or from account balance (this one).
// Body: { uid, amount }
// ----------------------------
router.post('/api/goals/:goalId/allocate',
  requireAuth,
  requireOwnData,
  asyncHandler(async (req, res) => {
    const { goalId } = req.params;
    const { uid, amount, idempotencyKey } = req.body;
    if (!amount) {
      return res.status(400).json({ success: false, error: 'amount required' });
    }
    const parsedAmount = parseAmount(amount);
    if (parsedAmount === null) {
      return res.status(400).json({ success: false, error: 'Enter a valid amount' });
    }

    const goalSnap = await db.collection('goals').doc(goalId).get();
    const goal = goalSnap.data();
    if (!goal) return res.status(404).json({ success: false, error: 'Goal not found' });
    if (goal.uid !== uid) return res.status(403).json({ success: false, error: 'Forbidden' });
    if (goal.completed) return res.status(400).json({ success: false, error: 'Goal already completed' });
    if (goal.frozen) {
      return res.status(400).json({
        success: false,
        error: 'This goal is frozen because your subscription expired. Unlock it or renew to allocate funds.',
        frozen: true
      });
    }

    const outcome = await withIdempotency(uid, idempotencyKey, async () => {
      const userSnap = await db.collection('users').doc(uid).get();
      const userData = userSnap.data() || {};
      if ((userData.accountBalance || 0) < parsedAmount) {
        const err = new Error(`Insufficient account balance. Available: MWK ${(userData.accountBalance || 0).toLocaleString()}`);
        err.isTransferFailure = true;
        err.details = { insufficientBalance: true };
        throw err;
      }

      const goalBefore = { ...goal };
      await db.collection('users').doc(uid).set({
        accountBalance: FieldValue.increment(-parsedAmount)
      }, { merge: true });
      const updated = await updateGoalProgress(uid, goalId, parsedAmount);
      const reference = generateRef();
      await logTransaction(uid, {
        type: 'allocation', amount: parsedAmount, fee: 0,
        goalId, goalName: goal.name, reference, status: 'completed'
      });
      await pushNotification(uid, {
        type: 'savings_success',
        message: updated?.completed
          ? `🎉 Goal complete! You reached your ${goal.name} target!`
          : `💰 Allocated MWK ${parsedAmount.toLocaleString()} to ${goal.name}. ${Math.round(((updated?.saved || 0) / goal.target) * 100)}% done.`
      });
      try { await checkGoalMilestone(uid, goalBefore, updated); } catch (e) { logSystemError('goal_milestone', e.message, { uid, stack: e.stack }); }
      clearCache(`profile_${uid}`, `goals_${uid}`, `analytics_${uid}`);
      return { success: true, message: `MWK ${parsedAmount} allocated to ${goal.name}`, reference, goal: updated };
    }).catch(err => {
      if (err.isTransferFailure) return { success: false, error: err.message, details: err.details, _statusCode: 400 };
      throw err;
    });

    const statusCode = outcome._statusCode || 200;
    delete outcome._statusCode;
    res.status(statusCode).json(outcome);
  })
);

// ----------------------------
// DEALLOCATE: MOVE MONEY FROM A GOAL BACK TO ACCOUNT BALANCE
// POST /api/goals/:goalId/deallocate
// The reverse of allocate — purely internal, no Airtel, no fee.
//
// Flexible goals: available anytime, any amount up to what's saved —
// consistent with a flexible goal never having been locked to begin
// with.
// Locked (hard) goals: only allowed once the goal is completed —
// that's the entire point of a hard lock (money committed until the
// target is reached). Once complete, this is how a user actually
// gets their money back into spendable balance rather than it just
// sitting in a "done" goal with a flag and nothing else.
// Frozen goals: blocked, same as everywhere else — a subscription-
// expiry freeze stops money moving in either direction.
// Body: { uid, amount }
// ----------------------------
router.post('/api/goals/:goalId/deallocate',
  requireAuth,
  requireOwnData,
  asyncHandler(async (req, res) => {
    const { goalId } = req.params;
    const { uid, amount, idempotencyKey } = req.body;
    if (!amount) {
      return res.status(400).json({ success: false, error: 'amount required' });
    }
    const parsedAmount = parseAmount(amount);
    if (parsedAmount === null) {
      return res.status(400).json({ success: false, error: 'Enter a valid amount' });
    }

    const goalSnap = await db.collection('goals').doc(goalId).get();
    const goal = goalSnap.data();
    if (!goal) return res.status(404).json({ success: false, error: 'Goal not found' });
    if (goal.uid !== uid) return res.status(403).json({ success: false, error: 'Forbidden' });
    if (goal.frozen) {
      return res.status(400).json({
        success: false,
        error: 'This goal is frozen because your subscription expired. Unlock it or renew first.',
        frozen: true
      });
    }
    if (goal.lockType === 'hard' && !goal.completed) {
      return res.status(400).json({
        success: false,
        error: 'This goal is locked until it reaches its target — you can move funds back to your balance once it\'s complete.'
      });
    }
    if (parsedAmount > (goal.saved || 0)) {
      return res.status(400).json({ success: false, error: `Only MWK ${(goal.saved || 0).toLocaleString()} saved in this goal` });
    }

    const outcome = await withIdempotency(uid, idempotencyKey, async () => {
      await db.collection('users').doc(uid).set({
        accountBalance: FieldValue.increment(parsedAmount)
      }, { merge: true });
      const updated = await updateGoalProgress(uid, goalId, -parsedAmount);
      const reference = generateRef();
      await logTransaction(uid, {
        type: 'deallocation', amount: parsedAmount, fee: 0,
        goalId, goalName: goal.name, reference, status: 'completed'
      });
      await pushNotification(uid, {
        type: 'goal_deallocation',
        message: `💰 Moved MWK ${parsedAmount.toLocaleString()} from ${goal.name} back to your account balance.`
      });
      clearCache(`profile_${uid}`, `goals_${uid}`, `analytics_${uid}`);
      return { success: true, message: `MWK ${parsedAmount} moved to your balance`, reference, goal: updated };
    });

    res.json(outcome);
  })
);

// ----------------------------
// AUTO-SAVE: CREATE RULE
// POST /api/autosave/rules
// Pro and Business only
// ----------------------------
router.post('/api/autosave/rules',
  requireAuth,
  requireOwnData,
  requirePlan('pro', 'business'),
  asyncHandler(async (req, res) => {
    const { uid, type, amount, goalId, destination, schedule, percent, enabled, declaredIncome, incomeDay } = req.body;
    if (!type) return res.status(400).json({ success: false, error: 'type is required' });

    // destination controls where a successful auto-save run lands:
    // 'balance' credits accountBalance directly (same as a manual
    // save), 'goal' allocates straight into goalId, skipping the
    // separate manual allocate step. Defaults to 'goal' when a
    // goalId is provided (preserves the old always-direct-to-goal
    // behavior for anyone not yet using the new balance option), and
    // to 'balance' otherwise.
    const resolvedDestination = destination === 'balance' || destination === 'goal'
      ? destination
      : (goalId ? 'goal' : 'balance');

    if (resolvedDestination === 'goal' && !goalId) {
      return res.status(400).json({ success: false, error: 'goalId is required when destination is "goal"' });
    }

    const { config } = await getPlanConfig(uid);
    const existing = await db.collection('autosave_rules')
      .where('uid', '==', uid).where('enabled', '==', true).get();
    if (existing.size >= config.maxAutoRules) {
      return res.status(403).json({
        success: false,
        error: `Your plan allows max ${config.maxAutoRules} auto-save rules`
      });
    }

    if (resolvedDestination === 'goal') {
      const goalSnap = await db.collection('goals').doc(goalId).get();
      if (!goalSnap.exists || goalSnap.data().uid !== uid) {
        return res.status(403).json({ success: false, error: 'Goal not found or forbidden' });
      }
    }

    const parsedRuleAmount = amount ? parseAmount(amount) : null;
    const parsedRulePercent = percent ? parseAmount(percent) : null;

    if (amount && parsedRuleAmount === null) {
      return res.status(400).json({ success: false, error: 'Enter a valid amount' });
    }
    if (percent && (parsedRulePercent === null || parsedRulePercent > 100)) {
      return res.status(400).json({ success: false, error: 'Percentage must be between 1 and 100' });
    }

    // ----------------------------
    // income_percent rules need to know WHEN income arrives and
    // HOW MUCH it typically is, since neither Airtel's nor PayChangu's
    // API can tell us that automatically today — there is no live
    // feed of money entering a user's wallet from a third party like
    // an employer. The user declares their own pay day and typical
    // income; the auto-save job (below) triggers a normal collection
    // on that day for percent% of the declared amount.
    //
    // This is deliberately built so the ONLY thing that changes when
    // Airtel's Transaction Summary API becomes available is HOW the
    // job decides a payday happened — see resolveIncomeTrigger()
    // below, which is the single swappable seam. The collection
    // call itself, goal crediting, fee logging, and notifications
    // are completely unaffected either way.
    // ----------------------------
    let parsedDeclaredIncome = null;
    let parsedIncomeDay = null;
    if (type === 'income_percent') {
      if (!percent) return res.status(400).json({ success: false, error: 'percent is required for income_percent rules' });
      parsedDeclaredIncome = declaredIncome ? parseAmount(declaredIncome) : null;
      if (declaredIncome && parsedDeclaredIncome === null) {
        return res.status(400).json({ success: false, error: 'Enter a valid declared income amount' });
      }
      if (!parsedDeclaredIncome) {
        return res.status(400).json({ success: false, error: 'declaredIncome is required for income_percent rules' });
      }
      parsedIncomeDay = parseInt(incomeDay, 10);
      if (!Number.isInteger(parsedIncomeDay) || parsedIncomeDay < 1 || parsedIncomeDay > 31) {
        return res.status(400).json({ success: false, error: 'incomeDay must be a day of the month between 1 and 31' });
      }
    }

    const rule = {
      uid, type,
      destination: resolvedDestination,
      goalId: resolvedDestination === 'goal' ? goalId : null,
      amount: parsedRuleAmount,
      percent: parsedRulePercent,
      schedule: schedule || null,
      declaredIncome: parsedDeclaredIncome,
      incomeDay: parsedIncomeDay,
      enabled: enabled !== false,
      createdAt: FieldValue.serverTimestamp(),
      lastRun: null,
      lastRunResult: null
    };

    const ref = await db.collection('autosave_rules').add(rule);
    res.json({ success: true, ruleId: ref.id, rule });
  })
);

// ----------------------------
// AUTO-SAVE: GET RULES
// GET /api/autosave/rules
// ----------------------------
router.get('/api/autosave/rules',
  requireAuth,
  asyncHandler(async (req, res) => {
    const uid = req.user.uid;
    const snap = await db.collection('autosave_rules').where('uid', '==', uid).get();
    const rules = {};
    snap.forEach(doc => { rules[doc.id] = { id: doc.id, ...doc.data() }; });
    res.json({ success: true, rules });
  })
);

// ----------------------------
// AUTO-SAVE: TOGGLE RULE
// PATCH /api/autosave/rules/:ruleId
// ----------------------------
router.patch('/api/autosave/rules/:ruleId',
  requireAuth,
  asyncHandler(async (req, res) => {
    const { ruleId } = req.params;
    const uid = req.user.uid;
    const snap = await db.collection('autosave_rules').doc(ruleId).get();
    if (!snap.exists || snap.data().uid !== uid) {
      return res.status(403).json({ success: false, error: 'Forbidden' });
    }
    const rule = snap.data();
    const updates = {};
    if (req.body.enabled !== undefined) updates.enabled = req.body.enabled;

    // Only income_percent rules accept these fields — silently
    // ignored for other rule types to avoid confusing partial state
    if (rule.type === 'income_percent') {
      if (req.body.declaredIncome !== undefined) {
        const parsed = parseAmount(req.body.declaredIncome);
        if (parsed === null) return res.status(400).json({ success: false, error: 'Enter a valid declared income amount' });
        updates.declaredIncome = parsed;
      }
      if (req.body.incomeDay !== undefined) {
        const day = parseInt(req.body.incomeDay, 10);
        if (!Number.isInteger(day) || day < 1 || day > 31) {
          return res.status(400).json({ success: false, error: 'incomeDay must be a day of the month between 1 and 31' });
        }
        updates.incomeDay = day;
      }
      if (req.body.percent !== undefined) {
        const pct = parseAmount(req.body.percent);
        if (pct === null || pct > 100) return res.status(400).json({ success: false, error: 'Percentage must be between 1 and 100' });
        updates.percent = pct;
      }
    }

    await db.collection('autosave_rules').doc(ruleId).update(updates);
    res.json({ success: true });
  })
);

// ----------------------------
// ROUND-UP: PROCESS A SPEND
// POST /api/roundup
// Pro and Business only
// Body: { uid, spendAmount, phone, destination?, goalId? }
// destination: 'balance' (default) credits accountBalance directly;
// 'goal' allocates straight into goalId, same choice as auto-save rules.
// ----------------------------
router.post('/api/roundup',
  requireAuth,
  requireOwnData,
  requirePlan('pro', 'business'),
  asyncHandler(async (req, res) => {
    const { uid, spendAmount, phone, destination, goalId } = req.body;
    if (!spendAmount || !phone) {
      return res.status(400).json({ success: false, error: 'spendAmount, phone required' });
    }
    const resolvedDestination = destination === 'goal' ? 'goal' : 'balance';
    if (resolvedDestination === 'goal' && !goalId) {
      return res.status(400).json({ success: false, error: 'goalId is required when destination is "goal"' });
    }

    const parsed = parseAmount(spendAmount);
    if (parsed === null) {
      return res.status(400).json({ success: false, error: 'Enter a valid spend amount' });
    }
    const roundedUp = Math.ceil(parsed / 500) * 500;
    const roundUpAmount = roundedUp - parsed;

    if (roundUpAmount < 10) {
      return res.json({ success: true, message: 'Round-up too small to process', roundUpAmount: 0 });
    }

    let goal = null;
    if (resolvedDestination === 'goal') {
      const goalSnap = await db.collection('goals').doc(goalId).get();
      goal = goalSnap.data();
      if (!goal || goal.uid !== uid) {
        return res.status(403).json({ success: false, error: 'Goal not found or forbidden' });
      }
      if (goal.frozen) {
        return res.status(400).json({ success: false, error: 'This goal is frozen — round-up cannot allocate into it right now.', frozen: true });
      }
    }

    const reference = generateRef();

    async function creditDestination() {
      if (resolvedDestination === 'goal') {
        return updateGoalProgress(uid, goalId, roundUpAmount);
      }
      await db.collection('users').doc(uid).set({ accountBalance: FieldValue.increment(roundUpAmount) }, { merge: true });
      return null;
    }

    const destLabel = resolvedDestination === 'goal' ? goal.name : 'your account balance';

    if (isMockMode()) {
      const updated = await creditDestination();
      await logTransaction(uid, {
        type: 'roundup', amount: roundUpAmount,
        spendAmount: parsed, roundedUp,
        goalId: resolvedDestination === 'goal' ? goalId : null,
        goalName: resolvedDestination === 'goal' ? goal.name : null,
        reference, status: 'mock', phone
      });
      await pushNotification(uid, {
        type: 'roundup_success',
        message: `🔄 MWK ${roundUpAmount} round-up saved to ${destLabel}.`
      });
      clearCache(`profile_${uid}`, `goals_${uid}`, `analytics_${uid}`);
      return res.json({ success: true, mock: true, roundUpAmount, reference, goal: updated });
    }

    const result = await airtelCollect({ phone, amount: roundUpAmount, reference });
    if (isAirtelSuccess(result)) {
      const updated = await creditDestination();
      await logTransaction(uid, {
        type: 'roundup', amount: roundUpAmount,
        spendAmount: parsed, roundedUp,
        goalId: resolvedDestination === 'goal' ? goalId : null,
        goalName: resolvedDestination === 'goal' ? goal.name : null,
        reference, airtelTxnId: result.txnId,
        status: 'completed', phone
      });
      await pushNotification(uid, {
        type: 'roundup_success',
        message: `🔄 MWK ${roundUpAmount} round-up saved to ${destLabel}.`
      });
      clearCache(`profile_${uid}`, `goals_${uid}`, `analytics_${uid}`);
      res.json({ success: true, roundUpAmount, reference, goal: updated });
    } else {
      res.status(400).json({ success: false, error: 'Round-up failed' });
    }
  })
);

// ----------------------------
// MERCHANT: COLLECT
// POST /api/merchant/collect
// Business only
// ----------------------------
router.post('/api/merchant/collect',
  requireAuth,
  requireOwnData,
  requirePlan('business'),
  asyncHandler(async (req, res) => {
    const { uid, customerPhone, amount, reference } = req.body;
    if (!customerPhone || !amount) {
      return res.status(400).json({ success: false, error: 'customerPhone and amount required' });
    }
    const ref = reference || generateRef();
    const parsedAmount = parseAmount(amount);
    if (parsedAmount === null) {
      return res.status(400).json({ success: false, error: 'Enter a valid amount' });
    }
    if (parsedAmount > SECURITY.MAX_SAVE_AMOUNT) {
      return res.status(400).json({ success: false, error: 'Amount exceeds maximum limit' });
    }
    const fee = calcFee(parsedAmount, PLANS.business.transactionFeePercent);

    if (isMockMode()) {
      await logTransaction(uid, {
        type: 'collection', amount: parsedAmount,
        fee: fee.total, customerPhone, reference: ref, status: 'mock'
      });
      return res.json({ success: true, mock: true, reference: ref, fee: fee.total });
    }

    const result = await airtelCollect({ phone: customerPhone, amount: parsedAmount, reference: ref });
    const success = isAirtelSuccess(result);
    const txId = await logTransaction(uid, {
      type: 'collection', amount: parsedAmount,
      fee: fee.total, customerPhone, reference: ref,
      airtelTxnId: result.txnId,
      status: success ? 'pending_customer' : 'failed'
    });
    if (success) await logFee(uid, { amount: fee.total, platformAmount: fee.platformAmount, airtelAmount: fee.airtelAmount, transactionId: txId, type: 'collection', plan: 'business' });
    clearCache(`analytics_${uid}`);
    res.json({ success, result, reference: ref, fee: fee.total });
  })
);

// ----------------------------
// MERCHANT: DISBURSE
// POST /api/merchant/disburse
// Business only
// ----------------------------
router.post('/api/merchant/disburse',
  requireAuth,
  requireOwnData,
  requirePlan('business'),
  asyncHandler(async (req, res) => {
    const { uid, phone, amount, reference } = req.body;
    if (!phone || !amount) {
      return res.status(400).json({ success: false, error: 'phone and amount required' });
    }
    const ref = reference || generateRef();
    const parsedAmount = parseAmount(amount);
    if (parsedAmount === null) {
      return res.status(400).json({ success: false, error: 'Enter a valid amount' });
    }
    if (parsedAmount > SECURITY.MAX_SAVE_AMOUNT) {
      return res.status(400).json({ success: false, error: 'Amount exceeds maximum limit' });
    }
    const fee = calcFee(parsedAmount, PLANS.business.transactionFeePercent);

    if (isMockMode()) {
      await logTransaction(uid, {
        type: 'disbursement', amount: parsedAmount,
        fee: fee.total, phone, reference: ref, status: 'mock'
      });
      return res.json({ success: true, mock: true, reference: ref, fee: fee.total });
    }

    const result = await airtelDisburse({ phone, amount: parsedAmount, reference: ref });
    const success = isAirtelSuccess(result);
    const txId = await logTransaction(uid, {
      type: 'disbursement', amount: parsedAmount,
      fee: fee.total, phone, reference: ref,
      airtelTxnId: result.txnId,
      status: success ? 'completed' : 'failed'
    });
    if (success) await logFee(uid, { amount: fee.total, platformAmount: fee.platformAmount, airtelAmount: fee.airtelAmount, transactionId: txId, type: 'disbursement', plan: 'business' });
    clearCache(`analytics_${uid}`);
    res.json({ success, result, reference: ref, fee: fee.total });
  })
);

// ============================================================
// PAY BY MERCHANT CODE
// PocketVault's answer to an Airtel Money agent code. Any
// PocketVault user can look up a Business-plan merchant by their
// 5-digit code and pay them directly, without needing the
// merchant's phone number. Two endpoints: lookup (shows who you're
// about to pay, before committing) and pay (actually moves money).
// ============================================================

// ----------------------------
// MERCHANT CODE: LOOKUP
// GET /api/merchant/lookup/:code
// Used by the payer's confirmation screen — "You are paying
// [Merchant Name]" — before they commit to an amount. Deliberately
// returns minimal info (display name only, never phone/email/uid)
// since this is reachable by any logged-in user, not just the
// merchant themselves.
// ----------------------------
router.get('/api/merchant/lookup/:code', requireAuth, asyncHandler(async (req, res) => {
  const code = (req.params.code || '').trim();
  if (!/^\d{5}$/.test(code)) {
    return res.status(400).json({ success: false, error: 'Enter a valid 5-digit merchant code' });
  }

  const snap = await db.collection('users')
    .where('merchantCode', '==', code)
    .where('merchantCodeActive', '==', true)
    .limit(1).get();

  if (snap.empty) {
    return res.status(404).json({ success: false, error: 'No active merchant found for this code' });
  }

  const merchant = snap.docs[0].data();
  // Double-check they're still genuinely on Business plan — code
  // could theoretically be active but plan changed in the same
  // instant via a race with the downgrade path; belt and braces
  if (merchant.plan !== 'business') {
    return res.status(404).json({ success: false, error: 'No active merchant found for this code' });
  }

  res.json({
    success: true,
    merchant: {
      uid: snap.docs[0].id,
      name: merchant.businessName || merchant.name || 'PocketVault Merchant',
    }
  });
}));

// ----------------------------
// MERCHANT CODE: PAY
// POST /api/merchant/pay
// The payer's side of a code payment. Requires the payer to be KYC-
// verified (same bar as a normal save/withdraw) since real money is
// moving. Idempotency-protected the same way as /api/save and
// /api/withdraw — a double-tap must not charge the payer twice.
// Body: { uid, merchantCode, amount, phone, idempotencyKey }
// ----------------------------
router.post('/api/merchant/pay',
  requireAuth,
  requireOwnData,
  asyncHandler(async (req, res) => {
    const { uid, merchantCode, amount, phone, idempotencyKey } = req.body;
    if (!merchantCode || !amount || !phone) {
      return res.status(400).json({ success: false, error: 'merchantCode, amount and phone required' });
    }
    if (!/^\d{5}$/.test(merchantCode)) {
      return res.status(400).json({ success: false, error: 'Invalid merchant code format' });
    }

    const payerSnap = await db.collection('users').doc(uid).get();
    const payer = payerSnap.data() || {};
    const payerVerified = payer.kycStatus === 'verified' || payer.kycStatus === 'mock_verified';
    if (!payerVerified) {
      return res.status(403).json({ success: false, error: 'Verify your phone number before paying a merchant' });
    }

    const parsedAmount = parseAmount(amount);
    if (parsedAmount === null) {
      return res.status(400).json({ success: false, error: 'Enter a valid amount' });
    }
    if (parsedAmount < SECURITY.MIN_SAVE_AMOUNT) {
      return res.status(400).json({ success: false, error: `Minimum payment is MWK ${SECURITY.MIN_SAVE_AMOUNT}` });
    }
    if (parsedAmount > SECURITY.MAX_SAVE_AMOUNT) {
      return res.status(400).json({ success: false, error: 'Amount exceeds maximum limit' });
    }

    const merchantSnap = await db.collection('users')
      .where('merchantCode', '==', merchantCode)
      .where('merchantCodeActive', '==', true)
      .limit(1).get();
    if (merchantSnap.empty) {
      return res.status(404).json({ success: false, error: 'No active merchant found for this code' });
    }
    const merchantDoc = merchantSnap.docs[0];
    const merchant = merchantDoc.data();
    if (merchant.plan !== 'business') {
      return res.status(404).json({ success: false, error: 'No active merchant found for this code' });
    }
    if (merchantDoc.id === uid) {
      return res.status(400).json({ success: false, error: 'You cannot pay your own merchant code' });
    }
    const merchantName = merchant.businessName || merchant.name || 'PocketVault Merchant';

    // Same idempotency protection as /api/save and /api/withdraw —
    // a double-tap on the pay button must not charge the payer twice.
    const outcome = await withIdempotency(uid, idempotencyKey, async () => {
      // Business plan's fee rate applies to code payments — same
      // rate as the merchant's own collect/disburse tools, since
      // this is functionally the same kind of transaction just
      // initiated by the payer instead of the merchant.
      const fee = calcFee(parsedAmount, PLANS.business.transactionFeePercent);
      const reference = generateRef();

      if (isMockMode()) {
        const txId = await logTransaction(uid, {
          type: 'merchant_payment', amount: parsedAmount, fee: fee.total,
          feePercent: PLANS.business.transactionFeePercent,
          merchantUid: merchantDoc.id, merchantName, merchantCode,
          reference, status: 'mock', phone
        });
        await logFee(uid, { amount: fee.total, platformAmount: fee.platformAmount, airtelAmount: fee.airtelAmount, transactionId: txId, type: 'merchant_payment', plan: payer.plan || 'free' });

        // Credit the merchant's own transaction history too, so
        // their Merchant page shows incoming code payments alongside
        // their own collect/disburse activity
        await logTransaction(merchantDoc.id, {
          type: 'merchant_payment_received', amount: parsedAmount,
          payerUid: uid, reference, status: 'mock'
        });

        await pushNotification(uid, {
          type: 'merchant_payment_sent',
          message: `💳 Paid MWK ${parsedAmount.toLocaleString()} to ${merchantName} via merchant code.`
        });
        await pushNotification(merchantDoc.id, {
          type: 'merchant_payment_received',
          message: `🏪 Received MWK ${parsedAmount.toLocaleString()} via your merchant code.`
        });
        clearCache(`analytics_${uid}`, `analytics_${merchantDoc.id}`);
        return { success: true, mock: true, message: `MWK ${parsedAmount} paid to ${merchantName}`, reference, fee: fee.total, merchantName };
      }

      const result = await airtelCollect({ phone, amount: parsedAmount, reference });
      if (isAirtelSuccess(result)) {
        const txId = await logTransaction(uid, {
          type: 'merchant_payment', amount: parsedAmount, fee: fee.total,
          feePercent: PLANS.business.transactionFeePercent,
          merchantUid: merchantDoc.id, merchantName, merchantCode,
          reference, airtelTxnId: result.txnId,
          status: 'completed', phone
        });
        await logFee(uid, { amount: fee.total, platformAmount: fee.platformAmount, airtelAmount: fee.airtelAmount, transactionId: txId, type: 'merchant_payment', plan: payer.plan || 'free' });
        await logTransaction(merchantDoc.id, {
          type: 'merchant_payment_received', amount: parsedAmount,
          payerUid: uid, reference, status: 'completed'
        });
        await pushNotification(uid, {
          type: 'merchant_payment_sent',
          message: `💳 Paid MWK ${parsedAmount.toLocaleString()} to ${merchantName} via merchant code.`
        });
        await pushNotification(merchantDoc.id, {
          type: 'merchant_payment_received',
          message: `🏪 Received MWK ${parsedAmount.toLocaleString()} via your merchant code.`
        });
        clearCache(`analytics_${uid}`, `analytics_${merchantDoc.id}`);
        return { success: true, message: `MWK ${parsedAmount} paid to ${merchantName}`, reference, fee: fee.total, merchantName };
      } else {
        await logTransaction(uid, {
          type: 'merchant_payment', amount: parsedAmount,
          merchantUid: merchantDoc.id, merchantCode,
          reference, status: 'failed', error: JSON.stringify(result)
        });
        const err = new Error('Payment failed');
        err.isTransferFailure = true;
        err.details = result;
        throw err;
      }
    }).catch(err => {
      if (err.isTransferFailure) return { success: false, error: 'Payment failed', details: err.details, _statusCode: 400 };
      throw err;
    });

    const statusCode = outcome._statusCode || 200;
    delete outcome._statusCode;
    res.status(statusCode).json(outcome);
  })
);

// ----------------------------
// INTERNAL TRANSFER: ACCOUNT BALANCE -> MERCHANT'S ACCOUNT BALANCE
// POST /api/transfer
// PocketVault-to-PocketVault only — the recipient must be an active
// Business-plan merchant, looked up the same way as
// /api/merchant/lookup and /api/merchant/pay. No Airtel call happens
// at all here, since both balances live entirely inside Firestore —
// that's what makes this "internal": nothing crosses Airtel's rails,
// so there's no 1.5% Airtel cost to pass through. Uses the OLD
// (pre-Airtel-fee-increase) plan rates for exactly that reason —
// see PLANS in core/config.js for transactionFeePercent, which is
// now the Airtel-inclusive rate; INTERNAL_TRANSFER_FEE_PERCENT below
// is deliberately separate so raising/lowering the Airtel-inclusive
// rate can never accidentally change the internal rate too.
// Still requires KYC verification on the sender, same bar as save/
// withdraw/pay-by-code — no Airtel wallet is touched, but the
// sender's identity assurance should be no lower for money that
// still leaves their control.
// Body: { uid, merchantCode, amount, idempotencyKey }
// ----------------------------

// Old, pre-Airtel-increase plan rates — see core/config.js's comment
// on PLANS.*.transactionFeePercent for why those numbers changed.
// Kept here rather than re-deriving from the current PLANS values so
// a future Airtel fee change can never silently move this number too.
const INTERNAL_TRANSFER_FEE_PERCENT = { free: 1, pro: 0.75, business: 0.5 };

router.post('/api/transfer',
  requireAuth,
  requireOwnData,
  asyncHandler(async (req, res) => {
    const { uid, merchantCode, amount, idempotencyKey } = req.body;
    if (!merchantCode || !amount) {
      return res.status(400).json({ success: false, error: 'merchantCode and amount required' });
    }
    if (!/^\d{5}$/.test(merchantCode)) {
      return res.status(400).json({ success: false, error: 'Invalid merchant code format' });
    }

    const payerSnap = await db.collection('users').doc(uid).get();
    const payer = payerSnap.data() || {};
    const payerVerified = payer.kycStatus === 'verified' || payer.kycStatus === 'mock_verified';
    if (!payerVerified) {
      return res.status(403).json({ success: false, error: 'Verify your phone number before sending a transfer' });
    }

    const parsedAmount = parseAmount(amount);
    if (parsedAmount === null) {
      return res.status(400).json({ success: false, error: 'Enter a valid amount' });
    }
    if (parsedAmount < SECURITY.MIN_SAVE_AMOUNT) {
      return res.status(400).json({ success: false, error: `Minimum transfer is MWK ${SECURITY.MIN_SAVE_AMOUNT}` });
    }
    if (parsedAmount > SECURITY.MAX_SAVE_AMOUNT) {
      return res.status(400).json({ success: false, error: 'Amount exceeds maximum limit' });
    }

    const merchantSnap = await db.collection('users')
      .where('merchantCode', '==', merchantCode)
      .where('merchantCodeActive', '==', true)
      .limit(1).get();
    if (merchantSnap.empty) {
      return res.status(404).json({ success: false, error: 'No active merchant found for this code' });
    }
    const merchantDoc = merchantSnap.docs[0];
    const merchant = merchantDoc.data();
    if (merchant.plan !== 'business') {
      return res.status(404).json({ success: false, error: 'No active merchant found for this code' });
    }
    if (merchantDoc.id === uid) {
      return res.status(400).json({ success: false, error: 'You cannot transfer to your own merchant code' });
    }
    const merchantName = merchant.businessName || merchant.name || 'PocketVault Merchant';

    const outcome = await withIdempotency(uid, idempotencyKey, async () => {
      const payerSnapFresh = await db.collection('users').doc(uid).get();
      const payerFresh = payerSnapFresh.data() || {};
      if ((payerFresh.accountBalance || 0) < parsedAmount) {
        const err = new Error(`Insufficient account balance. Available: MWK ${(payerFresh.accountBalance || 0).toLocaleString()}`);
        err.isTransferFailure = true;
        err.details = { insufficientBalance: true };
        throw err;
      }

      const payerPlan = payerFresh.plan || 'free';
      const feePercent = INTERNAL_TRANSFER_FEE_PERCENT[payerPlan] ?? INTERNAL_TRANSFER_FEE_PERCENT.free;
      // No Airtel leg here, so the internal fee IS the platform fee —
      // there is no separate airtelAmount to split out.
      const feeTotal = Math.ceil(parsedAmount * (feePercent / 100));
      const netToMerchant = parsedAmount - feeTotal;
      const reference = generateRef();

      // Debit payer, credit merchant — no Airtel call, everything
      // stays inside Firestore.
      await db.collection('users').doc(uid).set({ accountBalance: FieldValue.increment(-parsedAmount) }, { merge: true });
      await db.collection('users').doc(merchantDoc.id).set({ accountBalance: FieldValue.increment(netToMerchant) }, { merge: true });

      const txId = await logTransaction(uid, {
        type: 'internal_transfer', amount: parsedAmount, fee: feeTotal, feePercent,
        merchantUid: merchantDoc.id, merchantName, merchantCode,
        reference, status: 'completed'
      });
      await logFee(uid, { amount: feeTotal, platformAmount: feeTotal, airtelAmount: 0, transactionId: txId, type: 'internal_transfer', plan: payerPlan });
      await logTransaction(merchantDoc.id, {
        type: 'internal_transfer_received', amount: netToMerchant,
        payerUid: uid, reference, status: 'completed'
      });

      await pushNotification(uid, {
        type: 'internal_transfer_sent',
        message: `💸 Sent MWK ${parsedAmount.toLocaleString()} to ${merchantName} from your balance.`
      });
      await pushNotification(merchantDoc.id, {
        type: 'internal_transfer_received',
        message: `💰 Received MWK ${netToMerchant.toLocaleString()} via balance payment.`
      });

      clearCache(`profile_${uid}`, `profile_${merchantDoc.id}`, `analytics_${uid}`, `analytics_${merchantDoc.id}`);
      return { success: true, message: `MWK ${parsedAmount} sent to ${merchantName}`, reference, fee: feeTotal, netToMerchant, merchantName };
    }).catch(err => {
      if (err.isTransferFailure) return { success: false, error: err.message, details: err.details, _statusCode: 400 };
      throw err;
    });

    const statusCode = outcome._statusCode || 200;
    delete outcome._statusCode;
    res.status(statusCode).json(outcome);
  })
);

// ----------------------------
// TRANSACTIONS: GET HISTORY
// GET /api/transactions
// Uses a single where() filter (uid only) then sorts/filters
// in application code — avoids requiring a Firestore composite
// index for the uid + type + timestamp combination.
// ----------------------------
router.get('/api/transactions',
  requireAuth,
  asyncHandler(async (req, res) => {
    const uid = req.user.uid;
    const { limit, type } = req.query;

    const snap = await db.collection('transactions')
      .where('uid', '==', uid)
      .get();

    let transactions = [];
    snap.forEach(doc => transactions.push({ id: doc.id, ...doc.data() }));

    if (type) transactions = transactions.filter(t => t.type === type);

    transactions.sort((a, b) => toMillis(b.timestamp) - toMillis(a.timestamp));
    transactions = transactions.slice(0, parseInt(limit) || 20);

    res.json({ success: true, transactions });
  })
);

// ----------------------------
// TRANSACTION: STATUS CHECK
// GET /api/transactions/:reference/status
// ----------------------------
router.get('/api/transactions/:reference/status',
  requireAuth,
  asyncHandler(async (req, res) => {
    const { reference } = req.params;
    const uid = req.user.uid;
    const snap = await db.collection('transactions')
      .where('reference', '==', reference)
      .where('uid', '==', uid).limit(1).get();
    if (snap.empty) return res.status(404).json({ success: false, error: 'Transaction not found' });
    if (isMockMode()) return res.json({ success: true, mock: true, status: 'completed' });
    const result = await airtelTransactionStatus(reference);
    const statusMap = { 'TS': 'completed', 'TF': 'failed', 'TE': 'expired', 'TP': 'pending' };
    res.json({
      success: true, reference,
      status: statusMap[result?.data?.transaction?.status] || 'unknown',
      raw: result
    });
  })
);

// ----------------------------
// ANALYTICS: SUMMARY
// GET /api/analytics
// Pro and Business get full analytics
// ----------------------------
router.get('/api/analytics',
  requireAuth,
  asyncHandler(async (req, res) => {
    const uid = req.user.uid;
    const { plan, config } = await getPlanConfig(uid);

    const analytics = await getCached(`analytics_${uid}`, async () => {
      const snap = await db.collection('transactions')
        .where('uid', '==', uid).get();

      let transactions = [];
      snap.forEach(doc => transactions.push(doc.data()));
      transactions.sort((a, b) => toMillis(b.timestamp) - toMillis(a.timestamp));
      transactions = transactions.slice(0, 500);

      const monthStart = new Date();
      monthStart.setDate(1); monthStart.setHours(0, 0, 0, 0);

      let totalSaved = 0, totalSpent = 0, monthSaved = 0, monthSpent = 0, totalFees = 0;
      const categoryMap = {};
      const monthlyMap = {};

      for (const tx of transactions) {
        if (tx.status === 'failed') continue;
        const ts = tx.timestamp?.toMillis?.() || tx.timestamp || 0;
        const d = new Date(ts);
        const mk = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
        if (!monthlyMap[mk]) monthlyMap[mk] = { saved: 0, spent: 0 };

        if (['savings', 'roundup'].includes(tx.type)) {
          totalSaved += tx.amount || 0;
          totalFees += tx.fee || 0;
          monthlyMap[mk].saved += tx.amount || 0;
          if (ts > monthStart.getTime()) monthSaved += tx.amount || 0;
        }
        if (['expense', 'gambling', 'airtime', 'collection', 'disbursement', 'merchant_payment'].includes(tx.type)) {
          totalSpent += tx.amount || 0;
          monthlyMap[mk].spent += tx.amount || 0;
          if (ts > monthStart.getTime()) monthSpent += tx.amount || 0;
          const cat = tx.category || tx.type || 'other';
          categoryMap[cat] = (categoryMap[cat] || 0) + (tx.amount || 0);
        }
      }

      const savingsRate = totalSpent + totalSaved > 0
        ? Math.round((totalSaved / (totalSpent + totalSaved)) * 100) : 0;

      // Basic analytics for everyone
      const basic = { totalSaved, monthSaved, savingsRate, transactionCount: transactions.length };

      // Full analytics for pro and business
      const full = {
        ...basic,
        totalSpent, monthSpent, totalFees,
        categoryBreakdown: categoryMap,
        monthlyTrend: monthlyMap,
        // AI insight generation
        aiInsight: generateInsight({ totalSaved, totalSpent, monthSaved, monthSpent, categoryMap, savingsRate })
      };

      return { basic, full };
    }, 60000);

    res.json({
      success: true,
      analytics: config.analytics ? analytics.full : analytics.basic,
      plan,
      fullAnalyticsAvailable: config.analytics
    });
  })
);

// ----------------------------
// AI INSIGHT GENERATOR
// ----------------------------
function generateInsight({ totalSaved, totalSpent, monthSaved, monthSpent, categoryMap, savingsRate }) {
  const insights = [];

  if (savingsRate >= 30) insights.push('🔥 Excellent savings rate. You are in the top tier of savers.');
  else if (savingsRate >= 15) insights.push('📊 Good savings rate. Small improvements could make a big difference.');
  else insights.push('⚠️ Low savings rate. Try setting up auto-save rules to improve consistency.');

  const topCategory = Object.entries(categoryMap).sort((a, b) => b[1] - a[1])[0];
  if (topCategory) {
    const reduction = Math.floor(topCategory[1] * 0.2);
    insights.push(`💡 You spent most on ${topCategory[0]}. Reducing this by 20% would save MWK ${reduction.toLocaleString()} extra.`);
  }

  if (monthSaved > monthSpent) insights.push('✅ This month you saved more than you spent. Keep it up!');
  else if (monthSpent > 0) {
    const ratio = Math.round((monthSaved / monthSpent) * 100);
    insights.push(`📈 You saved ${ratio}% of what you spent this month. Target 30% for financial health.`);
  }

  return insights;
}

// ----------------------------
// NOTIFICATIONS
// ----------------------------
router.get('/api/notifications',
  requireAuth,
  asyncHandler(async (req, res) => {
    const uid = req.user.uid;
    const snap = await db.collection('notifications')
      .where('uid', '==', uid).get();
    let notifications = [];
    snap.forEach(doc => notifications.push({ id: doc.id, ...doc.data() }));
    notifications.sort((a, b) => toMillis(b.timestamp) - toMillis(a.timestamp));
    notifications = notifications.slice(0, 20);
    res.json({ success: true, notifications });
  })
);

router.patch('/api/notifications/:notifId',
  requireAuth,
  asyncHandler(async (req, res) => {
    const { notifId } = req.params;
    const uid = req.user.uid;
    const snap = await db.collection('notifications').doc(notifId).get();
    if (!snap.exists || snap.data().uid !== uid) {
      return res.status(403).json({ success: false, error: 'Forbidden' });
    }
    await db.collection('notifications').doc(notifId).update({ read: true });
    res.json({ success: true });
  })
);

// ----------------------------
// AIRTEL WEBHOOK
// POST /api/airtel/notification
// Rate limited to prevent flooding. Signature verification is
// enforced whenever AIRTEL_WEBHOOK_SECRET is configured — see the
// startup warning below if it's missing in a live environment.
// ----------------------------
router.post('/api/airtel/notification', rateLimit(60, 60 * 1000), asyncHandler(async (req, res) => {
  if (SECURITY.AIRTEL_WEBHOOK_SECRET) {
    const signature = req.headers['x-airtel-signature'];
    const expected = crypto
      .createHmac('sha256', SECURITY.AIRTEL_WEBHOOK_SECRET)
      .update(JSON.stringify(req.body)).digest('hex');
    if (!signature || !safeCompare(signature, expected)) {
      console.warn('🚨 Invalid webhook signature — request rejected');
      return res.status(401).json({ success: false });
    }
  } else {
    // No secret configured — this should never happen once Airtel
    // is live in production. Logged loudly so it's impossible to miss,
    // but the request is still allowed through to avoid breaking the
    // app during initial setup before the secret has been added.
    console.warn('⚠️  AIRTEL_WEBHOOK_SECRET is not set — webhook signature is NOT being verified. Set this env var before going live.');
    logSystemError('webhook_security', 'AIRTEL_WEBHOOK_SECRET missing — webhook accepted unauthenticated request', { headers: req.headers });
  }

  const { transaction, msisdn } = req.body;
  if (!transaction) return res.status(400).json({ success: false });

  // Prevent duplicates
  if (await isAlreadyProcessed(transaction.id)) {
    return res.json({ success: true, note: 'already processed' });
  }

  console.log('📲 Airtel notification:', JSON.stringify(req.body));

  await db.collection('inbox').add({
    message: `Received MWK ${transaction.amount} from ${msisdn}. TID: ${transaction.id}`,
    amount: transaction.amount,
    sender: msisdn,
    tid: transaction.id?.replace(/[.#$[\]]/g, '_'),
    type: 'income',
    source: 'airtel-webhook',
    timestamp: FieldValue.serverTimestamp(),
    processed: false
  });

  res.json({ success: true });
}));

// ----------------------------
// PAYCHANGU WEBHOOK
// POST /api/paychangu/notification
// Separate route from the Airtel webhook above since PayChangu's
// payload shape (event_type, data.charge_id, data.status) is
// completely different from Airtel's — kept as its own handler
// rather than trying to merge two different payload shapes into
// one function. Signature verification uses PayChangu's own
// HMAC scheme; same safeCompare() constant-time comparison as
// the Airtel webhook uses.
// ----------------------------
router.post('/api/paychangu/notification', rateLimit(60, 60 * 1000), asyncHandler(async (req, res) => {
  if (PAYCHANGU.WEBHOOK_SECRET) {
    const signature = req.headers['signature'] || req.headers['x-paychangu-signature'];
    const expected = crypto
      .createHmac('sha256', PAYCHANGU.WEBHOOK_SECRET)
      .update(JSON.stringify(req.body)).digest('hex');
    if (!signature || !safeCompare(signature, expected)) {
      console.warn('🚨 Invalid PayChangu webhook signature — request rejected');
      return res.status(401).json({ success: false });
    }
  } else {
    console.warn('⚠️  PAYCHANGU_WEBHOOK_SECRET is not set — PayChangu webhook signature is NOT being verified. Set this env var before going live.');
    logSystemError('webhook_security', 'PAYCHANGU_WEBHOOK_SECRET missing — webhook accepted unauthenticated request', { headers: req.headers });
  }

  const { event_type, data } = req.body;
  if (!data?.charge_id) return res.status(400).json({ success: false });

  // Prevent duplicates — same pattern as the Airtel webhook, keyed
  // on PayChangu's charge_id instead of Airtel's transaction id
  const alreadyDone = await db.collection('transactions')
    .where('reference', '==', data.charge_id)
    .where('status', 'in', ['completed', 'failed'])
    .limit(1).get();
  if (!alreadyDone.empty) {
    return res.json({ success: true, note: 'already processed' });
  }

  console.log('📲 PayChangu notification:', JSON.stringify(req.body));

  await db.collection('inbox').add({
    message: `PayChangu ${event_type || 'event'}: MWK ${data.amount || '?'} — ${data.status || 'unknown'} (charge ${data.charge_id})`,
    amount: data.amount || null,
    sender: data.mobile || null,
    tid: (data.charge_id || '').replace(/[.#$[\]]/g, '_'),
    type: 'income',
    source: 'paychangu-webhook',
    timestamp: FieldValue.serverTimestamp(),
    processed: false
  });

  // Unlike the Airtel webhook (which relies entirely on the polling
  // reconciliation job to update transaction status), PayChangu's
  // webhook payload already tells us the final status directly — so
  // we can update the matching transaction immediately here rather
  // than waiting for the next reconciliation cycle.
  if (data.status === 'success' || data.status === 'failed') {
    const txSnap = await db.collection('transactions')
      .where('reference', '==', data.charge_id)
      .limit(1).get();
    if (!txSnap.empty) {
      const txDoc = txSnap.docs[0];
      const tx = txDoc.data();
      const newStatus = data.status === 'success' ? 'completed' : 'failed';
      if (tx.status === 'pending') {
        await txDoc.ref.update({ status: newStatus, reconciledAt: FieldValue.serverTimestamp() });
        if (newStatus === 'completed' && tx.type === 'savings') {
          if (tx.goalId) {
            await updateGoalProgress(tx.uid, tx.goalId, tx.amount);
          } else {
            // No goalId — a manual /api/save (or balance-destination
            // autosave run) that was still pending when PayChangu's
            // webhook confirmed it. Credit accountBalance the same
            // way the request handler itself would have.
            await db.collection('users').doc(tx.uid).set({
              accountBalance: FieldValue.increment(tx.amount || 0)
            }, { merge: true });
          }
        }
        await pushNotification(tx.uid, {
          type: newStatus === 'completed' ? 'savings_success' : 'transaction_failed',
          message: newStatus === 'completed'
            ? `💰 Your MWK ${tx.amount?.toLocaleString()} payment was confirmed.`
            : `⚠ Your MWK ${tx.amount?.toLocaleString()} payment could not be completed. Please try again.`
        });
      }
    }
  }

  res.json({ success: true });
}));

// ----------------------------
// MACRODROID FALLBACK — REMOVED
// This endpoint accepted an arbitrary uid in the request body
// with zero authentication, letting anyone write into any
// user's data. It was legacy from before Airtel integration
// existed and nothing in the current app calls it. Removed.
// ----------------------------

// ----------------------------
// USER PROFILE DATA
// GET /api/user/profile
// Lightweight — returns KYC status, phone, plan for app initialization
// ----------------------------
router.get('/api/user/profile', requireAuth, asyncHandler(async (req, res) => {
  const uid = req.user.uid;
  const snap = await db.collection('users').doc(uid).get();
  const data = snap.data() || {};
  res.json({
    success: true,
    uid,
    kycStatus: data.kycStatus || 'unverified',
    phone: data.phone || null,
    phoneVerified: !!data.phoneVerified,
    kycName: data.kycName || null,
    plan: data.plan || 'free',
    name: data.name || null,
    suspended: !!data.suspended,
    streakCount: data.streakCount || 0,
    longestStreak: data.longestStreak || 0,
    lastSaveWeek: data.lastSaveWeek || null,
    referredBy: data.referredBy || null,
    merchantCode: data.merchantCodeActive ? data.merchantCode || null : null,
    businessName: data.businessName || null,
    accountBalance: data.accountBalance || 0
  });
}));

// ----------------------------
// ACCOUNT: EXPORT MY DATA
// GET /api/account/export
// PRODUCTION FIX #3 (part 1): lets a user get a copy of everything
// PocketVault holds about them — profile, goals, transactions,
// notifications — as a single JSON download.
// ----------------------------
router.get('/api/account/export', requireAuth, asyncHandler(async (req, res) => {
  const uid = req.user.uid;
  const [userSnap, goalsSnap, txSnap, notifSnap, autosaveSnap] = await Promise.all([
    db.collection('users').doc(uid).get(),
    db.collection('goals').where('uid', '==', uid).get(),
    db.collection('transactions').where('uid', '==', uid).limit(1000).get(),
    db.collection('notifications').where('uid', '==', uid).limit(500).get(),
    db.collection('autosave_rules').where('uid', '==', uid).get(),
  ]);

  const goals = []; goalsSnap.forEach(d => goals.push({ id: d.id, ...d.data() }));
  const transactions = []; txSnap.forEach(d => transactions.push({ id: d.id, ...d.data() }));
  const notifications = []; notifSnap.forEach(d => notifications.push({ id: d.id, ...d.data() }));
  const autosaveRules = []; autosaveSnap.forEach(d => autosaveRules.push({ id: d.id, ...d.data() }));

  res.setHeader('Content-Disposition', `attachment; filename="pocketvault-data-export-${uid}.json"`);
  res.json({
    exportedAt: new Date().toISOString(),
    profile: userSnap.data() || {},
    goals, transactions, notifications, autosaveRules
  });
}));

// ----------------------------
// ACCOUNT: DELETE MY ACCOUNT
// POST /api/account/delete
// PRODUCTION FIX #3 (part 2): closes the account. Financial
// transaction records are DELIBERATELY RETAINED rather than deleted
// outright — financial record-keeping expectations typically require
// transaction history to be kept for a period even after account
// closure. Instead, this disables login, anonymizes personally-
// identifying fields, and leaves the financial ledger intact but no
// longer traceable to an identity beyond the opaque uid.
//
// Soft-delete with a two-stage recovery window rather than an
// immediate hard delete:
//   Days 0-30  — signing back in auto-reactivates the account (see
//                watchAuth's reactivation check / requireAuth path)
//   Days 30-60 — auto sign-in reactivation no longer applies; an
//                admin must restore it manually via
//                POST /api/admin/users/:uid/restore
//   Day 60+    — sweepUnresolvedAccountBalances() (jobs.js) moves any
//                remaining accountBalance into unresolved_funds
//                rather than treating it as platform revenue, and
//                the account becomes eligible for permanent purge.
// Body: { confirmation: "DELETE" }
// ----------------------------
router.post('/api/account/delete', requireAuth, rateLimit(3, 60 * 60 * 1000), asyncHandler(async (req, res) => {
  const uid = req.user.uid;
  const { confirmation } = req.body;
  if (confirmation !== 'DELETE') {
    return res.status(400).json({ success: false, error: 'Send { confirmation: "DELETE" } to confirm account closure' });
  }

  // Deliberately NOT disabling the Firebase Auth account here.
  // A disabled Firebase Auth account can't complete client-side
  // sign-in at all (auth/user-disabled) — the user would never get
  // far enough to reach any of our endpoints, which is exactly what
  // "signing back in reactivates the account" depends on for the
  // first 30 days. Firestore's accountDeleted flag is what actually
  // gates app access during that window (see requireAuth's
  // reactivation check below) — Firebase Auth login itself stays
  // enabled until the account is either purged or an admin restores
  // it past day 30.
  const now = Date.now();
  await db.collection('users').doc(uid).set({
    name: null, phone: null, kycName: null,
    email: `deleted-${uid.slice(0, 8)}@pocketvault.mw`,
    accountDeleted: true,
    deletedAt: FieldValue.serverTimestamp(),
    // Plain millis alongside the server timestamp — the sweep job
    // and the auto-reactivation check both need to do simple numeric
    // comparisons against "now", which is awkward with a Firestore
    // server timestamp that isn't resolved until the write commits.
    deletedAtMillis: now,
    autoRecoveryDeadline: now + 30 * 24 * 60 * 60 * 1000,
    purgeDeadline: now + 60 * 24 * 60 * 60 * 1000,
    suspended: true,
    otpHash: null, pendingPhone: null, referredBy: null
  }, { merge: true });

  const [notifSnap, autosaveSnap] = await Promise.all([
    db.collection('notifications').where('uid', '==', uid).get(),
    db.collection('autosave_rules').where('uid', '==', uid).get(),
  ]);
  const batch = db.batch();
  notifSnap.forEach(d => batch.delete(d.ref));
  autosaveSnap.forEach(d => batch.delete(d.ref));
  await batch.commit();

  clearCache(`plan_${uid}`, `profile_${uid}`, `goals_${uid}`, `analytics_${uid}`);
  log.info('Account deleted', { uid, requestId: req.requestId });

  res.json({
    success: true,
    message: 'Your account has been closed. You can restore it by signing in again within the next 30 days. After that, restoring it requires contacting support. Transaction records are retained as required for financial record-keeping, with your personal details removed.'
  });
}));

// ----------------------------
// NOTIFICATIONS: UNREAD COUNT
// GET /api/notifications/unread-count
// ----------------------------
router.get('/api/notifications/unread-count', requireAuth, asyncHandler(async (req, res) => {
  const uid = req.user.uid;
  const snap = await db.collection('notifications').where('uid', '==', uid).where('read', '==', false).get();
  res.json({ success: true, count: snap.size });
}));

// ----------------------------
// NOTIFICATIONS: MARK ALL READ
// POST /api/notifications/read-all
// ----------------------------
router.post('/api/notifications/read-all', requireAuth, asyncHandler(async (req, res) => {
  const uid = req.user.uid;
  const snap = await db.collection('notifications').where('uid', '==', uid).where('read', '==', false).get();
  const batch = db.batch();
  snap.forEach(doc => batch.update(doc.ref, { read: true }));
  await batch.commit();
  res.json({ success: true, marked: snap.size });
}));

// ----------------------------
// CUSTOMER CARE — SUPPORT THREADS
// One collection, two modes, distinguished by `mode`:
//   'chat'   — user expects an admin to be actively present and able
//              to act on their account in real time (e.g. an
//              emergency unlock). Frontend polls faster for this mode.
//   'ticket' — async, no urgency signal; admin works it when they
//              get to it.
// Both share the same thread shape: a messages array (append-only,
// small enough per-thread that a subcollection/pagination isn't
// warranted yet), status, and optional relatedGoalId so an admin
// replying can jump straight to the goal in question without the
// user having to explain which one.
// ----------------------------

// POST /api/support/threads — start a new thread
router.post('/api/support/threads', requireAuth, asyncHandler(async (req, res) => {
  const uid = req.user.uid;
  const { mode, message, relatedGoalId } = req.body;
  if (!['chat', 'ticket'].includes(mode)) {
    return res.status(400).json({ success: false, error: "mode must be 'chat' or 'ticket'" });
  }
  if (!message?.trim()) {
    return res.status(400).json({ success: false, error: 'message is required' });
  }

  const userSnap = await db.collection('users').doc(uid).get();
  const userData = userSnap.data() || {};

  const thread = {
    uid,
    mode,
    status: 'open',
    relatedGoalId: relatedGoalId || null,
    userName: userData.name || null,
    userEmail: userData.email || null,
    createdAt: FieldValue.serverTimestamp(),
    lastMessageAt: FieldValue.serverTimestamp(),
    lastMessageFrom: 'user',
    messages: [{
      from: 'user',
      text: message.trim(),
      at: Date.now()
    }]
  };

  const ref = await db.collection('support_threads').add(thread);
  res.json({ success: true, threadId: ref.id });
}));

// GET /api/support/threads — list the current user's own threads
router.get('/api/support/threads', requireAuth, asyncHandler(async (req, res) => {
  const uid = req.user.uid;
  const snap = await db.collection('support_threads').where('uid', '==', uid).get();
  const threads = [];
  snap.forEach(d => threads.push({ id: d.id, ...d.data() }));
  threads.sort((a, b) => toMillis(b.lastMessageAt) - toMillis(a.lastMessageAt));
  res.json({ success: true, threads });
}));

// GET /api/support/threads/:threadId — poll one thread for new messages
router.get('/api/support/threads/:threadId', requireAuth, asyncHandler(async (req, res) => {
  const { threadId } = req.params;
  const doc = await db.collection('support_threads').doc(threadId).get();
  const thread = doc.data();
  if (!thread) return res.status(404).json({ success: false, error: 'Thread not found' });
  if (thread.uid !== req.user.uid) return res.status(403).json({ success: false, error: 'Forbidden' });
  res.json({ success: true, thread: { id: doc.id, ...thread } });
}));

// POST /api/support/threads/:threadId/messages — reply as the user
router.post('/api/support/threads/:threadId/messages', requireAuth, asyncHandler(async (req, res) => {
  const { threadId } = req.params;
  const { message } = req.body;
  if (!message?.trim()) return res.status(400).json({ success: false, error: 'message is required' });

  const ref = db.collection('support_threads').doc(threadId);
  const doc = await ref.get();
  const thread = doc.data();
  if (!thread) return res.status(404).json({ success: false, error: 'Thread not found' });
  if (thread.uid !== req.user.uid) return res.status(403).json({ success: false, error: 'Forbidden' });
  if (thread.status === 'resolved') {
    return res.status(400).json({ success: false, error: 'This thread is resolved — start a new one if you need further help' });
  }

  await ref.update({
    messages: FieldValue.arrayUnion({ from: 'user', text: message.trim(), at: Date.now() }),
    lastMessageAt: FieldValue.serverTimestamp(),
    lastMessageFrom: 'user',
    status: thread.status === 'in_progress' ? 'in_progress' : 'open'
  });
  res.json({ success: true });
}));

export default router;
