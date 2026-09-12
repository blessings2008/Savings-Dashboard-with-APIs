// PocketVault server entry point.
import express from 'express';
import cors from 'cors';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { existsSync } from 'fs';
import crypto from 'crypto';

import { validateEnvironment } from './core/firebase.js';
import { AIRTEL, PAYCHANGU, SECURITY, resolvePaymentProvider } from './core/config.js';
import { sanitizeBody, rateLimit } from './core/middleware.js';
import { log, logSystemError, sendExternalAlert, fetchWithRetry } from './helpers.js';

import userRoutes from './routes/user.js';
import adminRoutes, { resolveAIProvider } from './routes/admin.js';
import referralAdminRoutes from './routes/referrals-admin.js';

import {
  reconcilePendingTransactions, monitorFloat, checkExpiredSubscriptions,
  checkGoalDeadlines, checkFrozenGoalGracePeriod, runAutosaveRules,
  sweepUnresolvedFunds, checkTransactionSummaries, proactiveAnomalyCheck
} from './jobs.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
validateEnvironment();
const app = express();
const PORT = process.env.PORT || 3000;

app.use((req,res,next)=>{res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('X-Frame-Options','DENY');res.setHeader('X-XSS-Protection','1; mode=block');res.setHeader('Referrer-Policy','strict-origin-when-cross-origin');res.setHeader('Permissions-Policy','geolocation=(), microphone=(), camera=()');res.removeHeader('X-Powered-By');next();});
app.use((req,res,next)=>{req.requestId=crypto.randomBytes(6).toString('hex');res.setHeader('X-Request-Id',req.requestId);next();});
app.use(cors({origin:[`https://${process.env.APP_DOMAIN||'savings-dashboard-with-apis-2-0.onrender.com'}`,'http://localhost:3000'],methods:['GET','POST','PATCH','DELETE'],allowedHeaders:['Content-Type','Authorization','x-admin-secret','Idempotency-Key'],credentials:true}));
app.use(express.json({limit:'1mb'}));
app.use(sanitizeBody);app.use(express.static(__dirname));app.set('trust proxy',1);
app.use('/api/',rateLimit(300,15*60*1000));
app.use('/api/save',rateLimit(10,60*1000));app.use('/api/withdraw',rateLimit(5,60*1000));app.use('/api/subscribe',rateLimit(5,60*1000));app.use('/api/merchant/collect',rateLimit(20,60*1000));app.use('/api/merchant/disburse',rateLimit(20,60*1000));app.use('/api/kyc',rateLimit(5,60*1000));
app.use('/',userRoutes);app.use('/',referralAdminRoutes);app.use('/',adminRoutes);
app.use('/admin',express.static(join(__dirname,'admin')));
app.get('*',(req,res)=>{if(req.path.startsWith('/admin')){const adminIndex=join(__dirname,'admin','index.html');if(existsSync(adminIndex))return res.sendFile(adminIndex);return res.status(404).json({success:false,error:'Admin panel not deployed'});}res.sendFile(join(__dirname,'index.html'));});
app.use((err,req,res,next)=>{logSystemError(err,{requestId:req.requestId,path:req.path,method:req.method});if(res.headersSent)return next(err);res.status(err.status||500).json({success:false,error:err.message||'Internal server error',requestId:req.requestId});});

async function boot(){try{log('info',`PocketVault starting on port ${PORT}`);log('info',`Payment provider: ${resolvePaymentProvider()}`);log('info',`Admin AI provider: ${resolveAIProvider()||'none configured'}`);app.listen(PORT,()=>log('info',`Server listening on ${PORT}`));setInterval(reconcilePendingTransactions,5*60*1000);setInterval(monitorFloat,15*60*1000);setInterval(checkExpiredSubscriptions,60*60*1000);setInterval(checkGoalDeadlines,60*60*1000);setInterval(checkFrozenGoalGracePeriod,60*60*1000);setInterval(runAutosaveRules,60*60*1000);setInterval(sweepUnresolvedFunds,24*60*60*1000);setInterval(checkTransactionSummaries,15*60*1000);setInterval(proactiveAnomalyCheck,15*60*1000);}catch(err){logSystemError(err,{phase:'boot'});process.exit(1);}}
boot();
