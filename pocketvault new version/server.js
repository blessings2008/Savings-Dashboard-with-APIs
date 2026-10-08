import express from 'express';
import cors from 'cors';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { existsSync } from 'fs';
import crypto from 'crypto';
import { validateEnvironment, db, adminAuth } from './core/firebase.js';
import { AIRTEL, PAYCHANGU, SECURITY, resolvePaymentProvider, isMockMode } from './core/config.js';
import { sanitizeBody, rateLimit, requireAuth, requireAdmin, serializeUserMutation } from './core/middleware.js';
import { requireTransactionPin } from './core/transaction-pin-guard.js';
import { log, logSystemError, sendExternalAlert, fetchWithRetry } from './helpers.js';
import { sendEmail, buildWelcomeEmail } from './services/email.js';
import { scanForAttention, runSecondMeMonthlyReport, resolveSystemAIProvider } from './core/system-ai.js';
import userRoutes from './routes/user.js';
import userAIRoutes from './routes/user-ai.js';
import userAIInsightRoutes from './routes/user-ai-insights.js';
import userSupportAIRoutes from './routes/user-support-ai.js';
import transactionPinRoutes from './routes/transaction-pin.js';
import adminRoutes, { resolveAIProvider } from './routes/admin.js';
import emailRoutes from './routes/email.js';
import referralAdminRoutes from './routes/referrals-admin.js';
import systemAIRoutes from './routes/system-ai.js';
import { reconcilePendingTransactions, monitorFloat, checkExpiredSubscriptions, checkGoalDeadlines, checkFrozenGoalGracePeriod, runAutosaveRules, sweepUnresolvedFunds, checkTransactionSummaries, proactiveAnomalyCheck } from './jobs.js';
const __filename=fileURLToPath(import.meta.url);const __dirname=dirname(__filename);validateEnvironment();const app=express();const PORT=process.env.PORT||3000;
app.use((req,res,next)=>{res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('X-Frame-Options','DENY');res.setHeader('X-XSS-Protection','1; mode=block');res.setHeader('Referrer-Policy','strict-origin-when-cross-origin');res.setHeader('Permissions-Policy','geolocation=(), microphone=(), camera=()');if(process.env.NODE_ENV==='production')res.setHeader('Strict-Transport-Security','max-age=31536000; includeSubDomains');res.removeHeader('X-Powered-By');next();});app.use((req,res,next)=>{req.requestId=crypto.randomBytes(6).toString('hex');res.setHeader('X-Request-Id',req.requestId);next();});
const allowedOrigins=[`https://${process.env.APP_DOMAIN||'savings-dashboard-with-apis-2-0.onrender.com'}`];if(process.env.NODE_ENV!=='production')allowedOrigins.push('http://localhost:3000');
app.use(cors({origin:allowedOrigins,methods:['GET','POST','PATCH','DELETE'],allowedHeaders:['Content-Type','Authorization','x-admin-secret'],credentials:true}));
app.use(express.json({limit:'1mb',verify:(req,res,buf)=>{req.rawBody=Buffer.from(buf);}}));app.use(sanitizeBody);app.set('trust proxy',1);app.use('/api/',rateLimit(300,15*60*1000));app.use('/api/save',rateLimit(10,60*1000));app.use('/api/withdraw',rateLimit(5,60*1000));app.use('/api/transfer',rateLimit(10,60*1000));app.use('/api/merchant/pay',rateLimit(10,60*1000));app.use('/api/subscribe',rateLimit(5,60*1000));app.use('/api/merchant/collect',rateLimit(20,60*1000));app.use('/api/merchant/disburse',rateLimit(20,60*1000));app.use('/api/kyc',rateLimit(5,60*1000));app.use('/api/security/transaction-pin',rateLimit(10,15*60*1000));

// SECURITY GATES:
// In production, phone verification must not fall back to an in-app OTP.
// The current app has no real SMS/USSD OTP delivery provider, so allowing
// this flow would let an authenticated user verify a phone number without
// proving possession of that number. Keep KYC available in mock mode only
// until a real possession-verification channel is implemented.
app.use('/api/kyc', (req,res,next)=>{
  if (!isMockMode()) {
    return res.status(503).json({
      success:false,
      error:'Phone verification is temporarily unavailable while secure SMS verification is being configured.',
      code:'PHONE_VERIFICATION_PROVIDER_REQUIRED'
    });
  }
  next();
});

const safeCompareWebhookSignature=(a,b)=>{
  if(typeof a!=='string'||typeof b!=='string'||a.length!==b.length||a.length===0)return false;
  try{return crypto.timingSafeEqual(Buffer.from(a,'utf8'),Buffer.from(b,'utf8'));}catch{return false;}
};
// Payment webhooks must never accept unauthenticated traffic just because
// their signing secret was omitted. A missing secret is a deployment error.
app.use('/api/airtel/notification', (req,res,next)=>{
  if (!SECURITY.AIRTEL_WEBHOOK_SECRET) {
    return res.status(503).json({success:false,error:'Webhook verification is not configured.'});
  }
  next();
});
app.use('/api/paychangu/notification', async (req,res,next)=>{
  if (!PAYCHANGU.WEBHOOK_SECRET) {
    return res.status(503).json({success:false,error:'Webhook verification is not configured.'});
  }

  // Verify against the raw request bytes, not JSON.stringify(req.body).
  // HMAC signatures authenticate the exact payload PayChangu sent.
  const signature=String(req.headers['signature']||req.headers['x-paychangu-signature']||'');
  const expected=crypto.createHmac('sha256',PAYCHANGU.WEBHOOK_SECRET).update(req.rawBody||Buffer.from('')).digest('hex');
  if (!signature || !safeCompareWebhookSignature(signature,expected)) {
    return res.status(401).json({success:false,error:'Invalid webhook signature.'});
  }

  // PayChangu recommends re-querying the transaction before granting value.
  // Do that here before the existing route is allowed to process a success.
  const payload=req.body||{};
  const webhookData=payload.data||payload;
  const chargeId=webhookData.charge_id||webhookData.chargeId;
  if (!chargeId) return res.status(400).json({success:false,error:'Missing PayChangu charge ID.'});

  try {
    const verifyRes=await fetchWithRetry(`${PAYCHANGU.BASE_URL}/mobile-money/payments/${encodeURIComponent(chargeId)}/verify`,{
      headers:{Accept:'application/json',Authorization:`Bearer ${PAYCHANGU.SECRET_KEY}`}
    },{timeoutMs:10000,maxRetries:1,provider:'paychangu'});
    const verifyBody=await verifyRes.json().catch(()=>null);
    if (!verifyRes.ok) {
      return res.status(503).json({success:false,error:'Payment verification is temporarily unavailable.'});
    }
    const verified=verifyBody?.data?.transaction||verifyBody?.data||{};
    const verifiedChargeId=verified.charge_id||verified.chargeId;
    const verifiedStatus=String(verified.status||'').toLowerCase();
    if (String(verifiedChargeId)!==String(chargeId)) {
      return res.status(401).json({success:false,error:'Payment verification mismatch.'});
    }
    const webhookStatus=String(webhookData.status||'').toLowerCase();
    if (webhookStatus==='success' && verifiedStatus!=='success') {
      return res.status(409).json({success:false,error:'Payment status could not be independently verified.'});
    }

    // Normalize current PayChangu mobile-money webhook payloads into the
    // shape expected by the existing route without trusting the webhook's
    // success status beyond the independent verification above.
    if (!req.body.data && payload.charge_id) req.body.data=payload;
    next();
  } catch (error) {
    return next(error);
  }
});

app.use('/api/save',serializeUserMutation);app.use('/api/subscribe',serializeUserMutation);app.use('/api/withdraw',serializeUserMutation);app.use('/api/transfer',serializeUserMutation);app.use('/api/merchant/pay',serializeUserMutation);app.use('/api/merchant/collect',serializeUserMutation);app.use('/api/merchant/disburse',serializeUserMutation);app.use('/api/roundup',serializeUserMutation);app.use('/api/goals/:goalId/allocate',serializeUserMutation);app.use('/api/goals/:goalId/deallocate',serializeUserMutation);
app.use('/api/withdraw',requireTransactionPin);app.use('/api/transfer',requireTransactionPin);app.use('/api/merchant/pay',requireTransactionPin);app.use('/api/merchant/disburse',requireTransactionPin);
app.post('/api/profile',requireAuth,async(req,res,next)=>{const uid=req.user.uid;try{const snap=await db.collection('users').doc(uid).get();const data=snap.data()||{};if(!data.welcomeEmailSentAt){const user=await adminAuth.getUser(uid);if(user.email){const name=data.name||user.displayName||req.body.name||'there';try{const template=buildWelcomeEmail(name);const result=await sendEmail({to:user.email,subject:'Welcome to PocketVault 🇲🇼',idempotencyKey:`welcome-user/${uid}`,tags:[{name:'category',value:'welcome'},{name:'product',value:'pocketvault'}],...template});await db.collection('users').doc(uid).set({welcomeEmailSentAt:new Date().toISOString(),welcomeEmailId:result?.id||null},{merge:true});}catch(emailError){log.warn('Welcome email failed; continuing profile request',{uid,error:emailError.message,code:emailError.code||null});}}}}catch(error){log.warn('Welcome email preflight failed; continuing profile request',{uid,error:error.message});}next();});
// SECURITY: data exports must never include authentication material such as
// transaction-PIN hashes/salts or active OTP state. The legacy route handlers
// returned the raw users document, so these guarded replacements run first.
const redactExportProfile=(profile={})=>{
  const safe={...profile};
  delete safe.transactionPin;
  delete safe.otpHash;
  delete safe.otpExpiry;
  delete safe.otpAttempts;
  delete safe.pendingPhone;
  return safe;
};
app.get('/api/account/export',requireAuth,async(req,res,next)=>{
  try{
    const uid=req.user.uid;
    const [userSnap,goalsSnap,txSnap,notifSnap,autosaveSnap]=await Promise.all([
      db.collection('users').doc(uid).get(),db.collection('goals').where('uid','==',uid).get(),
      db.collection('transactions').where('uid','==',uid).limit(1000).get(),
      db.collection('notifications').where('uid','==',uid).limit(500).get(),
      db.collection('autosave_rules').where('uid','==',uid).get()
    ]);
    const collect=snap=>snap.docs.map(d=>({id:d.id,...d.data()}));
    res.setHeader('Content-Disposition',`attachment; filename="pocketvault-data-export-${uid}.json"`);
    res.json({exportedAt:new Date().toISOString(),profile:redactExportProfile(userSnap.data()||{}),goals:collect(goalsSnap),transactions:collect(txSnap),notifications:collect(notifSnap),autosaveRules:collect(autosaveSnap)});
  }catch(error){next(error);}
});
app.get('/api/admin/users/:uid/export',requireAdmin,async(req,res,next)=>{
  try{
    const uid=req.params.uid;
    const authUser=await adminAuth.getUser(uid).catch(()=>null);
    if(!authUser)return res.status(404).json({success:false,error:'User not found'});
    const [userSnap,goalsSnap,txSnap,notifSnap,autosaveSnap]=await Promise.all([
      db.collection('users').doc(uid).get(),db.collection('goals').where('uid','==',uid).get(),
      db.collection('transactions').where('uid','==',uid).limit(1000).get(),
      db.collection('notifications').where('uid','==',uid).limit(500).get(),
      db.collection('autosave_rules').where('uid','==',uid).get()
    ]);
    const collect=snap=>snap.docs.map(d=>({id:d.id,...d.data()}));
    log.info('Admin exported user data',{uid,exportedVia:'admin'});
    res.setHeader('Content-Disposition',`attachment; filename="pocketvault-data-export-${uid}.json"`);
    res.json({exportedAt:new Date().toISOString(),exportedByAdmin:true,authAccount:{email:authUser.email,displayName:authUser.displayName||null,createdAt:authUser.metadata?.creationTime||null},profile:redactExportProfile(userSnap.data()||{}),goals:collect(goalsSnap),transactions:collect(txSnap),notifications:collect(notifSnap),autosaveRules:collect(autosaveSnap)});
  }catch(error){next(error);}
});

app.use('/',userRoutes);app.use('/',userAIRoutes);app.use('/',userAIInsightRoutes);app.use('/',userSupportAIRoutes);app.use('/',transactionPinRoutes);app.use('/',referralAdminRoutes);app.use('/',systemAIRoutes);app.use('/',adminRoutes);app.use('/',emailRoutes);app.use('/admin',express.static(join(__dirname,'admin')));
app.get('*',(req,res)=>{if(req.path.startsWith('/admin')){const adminIndex=join(__dirname,'admin','index.html');if(existsSync(adminIndex))return res.sendFile(adminIndex);return res.status(404).json({success:false,error:'Admin panel not deployed'});}const indexPath=join(__dirname,'index.html');if(existsSync(indexPath))res.sendFile(indexPath);else res.status(200).json({status:'ok',app:'PocketVault API',message:'Backend running. No frontend deployed yet.',health:'/api/health'});});
app.use((err,req,res,next)=>{const message=err.message||'Unknown error';log.error('Unhandled request error',{requestId:req.requestId,url:req.url,method:req.method,error:message,stack:err.stack});logSystemError('express',message,{stack:err.stack,url:req.url,method:req.method,requestId:req.requestId});sendExternalAlert('Unhandled request error',`${req.method} ${req.url}\n${message}\nRequest: ${req.requestId}`);if(err.statusCode&&err.statusCode>=400&&err.statusCode<500)return res.status(err.statusCode).json({success:false,error:message,requestId:req.requestId});const unavailable=err.code===14||err.code===4||/UNAVAILABLE|DEADLINE_EXCEEDED/i.test(message);if(unavailable)return res.status(503).json({success:false,error:'Our database is temporarily unavailable. Please try again in a few moments.',requestId:req.requestId});res.status(500).json({success:false,error:'Something went wrong. Please try again.',requestId:req.requestId});});
process.on('uncaughtException',err=>{console.error('Uncaught:',err.message);logSystemError('uncaughtException',err.message,{stack:err.stack});sendExternalAlert('Uncaught exception',`${err.message}\n${(err.stack||'').slice(0,500)}`);});process.on('unhandledRejection',reason=>{const message=reason instanceof Error?reason.message:String(reason);console.error('Rejection:',message);logSystemError('unhandledRejection',message,{stack:reason?.stack});sendExternalAlert('Unhandled promise rejection',message);});
const JOB_START_DELAY=60*1000;setTimeout(()=>{setInterval(reconcilePendingTransactions,5*60*1000);setInterval(monitorFloat,30*60*1000);setInterval(checkExpiredSubscriptions,24*60*60*1000);setInterval(checkGoalDeadlines,24*60*60*1000);setInterval(checkFrozenGoalGracePeriod,24*60*60*1000);setInterval(sweepUnresolvedFunds,24*60*60*1000);setInterval(runAutosaveRules,24*60*60*1000);setInterval(checkTransactionSummaries,5*60*1000);setInterval(proactiveAnomalyCheck,15*60*1000);setInterval(()=>scanForAttention().catch(e=>logSystemError('second_me_scan',e.message,{stack:e.stack})),5*60*1000);let secondMeMonthlyRunKey='';async function scheduleSecondMeMonthlyReport(){const now=new Date();if(now.getDate()!==1)return;const key=`${now.getFullYear()}-${now.getMonth()+1}`;if(secondMeMonthlyRunKey===key)return;secondMeMonthlyRunKey=key;try{await runSecondMeMonthlyReport();}catch(e){secondMeMonthlyRunKey='';await logSystemError('second_me_monthly_report',e.message,{stack:e.stack});}}setInterval(scheduleSecondMeMonthlyReport,60*60*1000);},JOB_START_DELAY);const server=app.listen(PORT,()=>{const active=resolvePaymentProvider();const label={airtel_direct:'Airtel Direct',paychangu:'PayChangu (bridge)',mock:'Mock mode — no provider configured'}[active];console.log(`PocketVault backend ready on ${PORT} | Payments: ${label} | Admin AI: ${resolveAIProvider()||'not configured'} | Second Me: ${resolveSystemAIProvider()||'not configured'}`);});export default app;
