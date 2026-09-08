import { createHash } from 'node:crypto';
import { db, adminAuth } from '../core/firebase.js';
import { buildTransactionHistoryPdf, buildMonthlyAdminPdf } from './pdf.js';
import { sendEmail } from './email.js';

function toDate(value, fallback) {
  const d = value ? new Date(value) : fallback;
  return Number.isNaN(d.getTime()) ? fallback : d;
}

function timestampMillis(value) {
  if (!value) return 0;
  if (typeof value.toMillis === 'function') return value.toMillis();
  if (value._seconds) return value._seconds * 1000;
  const n = new Date(value).getTime();
  return Number.isNaN(n) ? 0 : n;
}

export async function getUserTransactionsReport(uid, { from, to, limit = 2000 } = {}) {
  const now = new Date();
  const defaultFrom = new Date(now.getFullYear(), now.getMonth() - 12, 1);
  const defaultTo = now;
  const fromDate = toDate(from, defaultFrom);
  const toDateValue = toDate(to, defaultTo);

  const [userSnap, txSnap] = await Promise.all([
    db.collection('users').doc(uid).get(),
    db.collection('transactions').where('uid', '==', uid).limit(Math.min(5000, Math.max(1, Number(limit) || 2000))).get()
  ]);
  const user = userSnap.data() || {};
  const transactions = txSnap.docs.map(doc => ({ id: doc.id, ...doc.data() }))
    .filter(tx => {
      const t = timestampMillis(tx.timestamp);
      return t >= fromDate.getTime() && t <= toDateValue.getTime();
    })
    .sort((a, b) => timestampMillis(b.timestamp) - timestampMillis(a.timestamp));

  return { user: { name: user.name || 'PocketVault user', email: user.email || (await adminAuth.getUser(uid)).email || '' }, transactions, from: fromDate, to: toDateValue };
}

export async function createUserTransactionPdf(uid, options = {}) {
  const report = await getUserTransactionsReport(uid, options);
  const pdf = await buildTransactionHistoryPdf(report);
  return { ...report, pdf };
}

export async function sendUserTransactionPdf(uid, options = {}) {
  const report = await createUserTransactionPdf(uid, options);
  const result = await sendEmail({
    to: report.user.email,
    subject: 'Your PocketVault transaction history',
    idempotencyKey: `transaction-report/${uid}/${report.from.toISOString().slice(0, 10)}/${report.to.toISOString().slice(0, 10)}`,
    tags: [{ name: 'category', value: 'report' }, { name: 'report_type', value: 'transaction_history' }],
    html: `<p style="font-family:Arial,sans-serif;color:#334155">Your requested PocketVault transaction history is attached as a PDF.</p><p style="font-family:Arial,sans-serif;color:#64748b">Period: ${report.from.toLocaleDateString('en-MW')} to ${report.to.toLocaleDateString('en-MW')}</p>`,
    text: `Your requested PocketVault transaction history is attached as a PDF. Period: ${report.from.toLocaleDateString('en-MW')} to ${report.to.toLocaleDateString('en-MW')}.`,
    attachments: [{ filename: `pocketvault-transactions-${report.from.toISOString().slice(0, 10)}-to-${report.to.toISOString().slice(0, 10)}.pdf`, content: report.pdf }]
  });
  return { ...report, emailId: result?.id || null };
}

export async function buildMonthlyAdminReport({ year, month }) {
  const start = new Date(year, month - 1, 1);
  const end = new Date(year, month, 1);
  const [usersSnap, txSnap] = await Promise.all([
    db.collection('users').limit(5000).get(),
    db.collection('transactions').limit(10000).get()
  ]);

  const users = usersSnap.docs.map(doc => ({ id: doc.id, ...doc.data() }));
  const transactions = txSnap.docs.map(doc => ({ id: doc.id, ...doc.data() }))
    .filter(tx => { const t = timestampMillis(tx.timestamp); return t >= start.getTime() && t < end.getTime(); })
    .sort((a, b) => timestampMillis(b.timestamp) - timestampMillis(a.timestamp));

  const completed = transactions.filter(tx => String(tx.status || '').toLowerCase() === 'completed');
  const sumType = type => completed.filter(tx => tx.type === type).reduce((sum, tx) => sum + Number(tx.amount || 0), 0);
  const totalUsers = users.length;
  const newUsers = users.filter(user => {
    const created = timestampMillis(user.createdAt || user.created_at);
    return created >= start.getTime() && created < end.getTime();
  }).length;
  const free = users.filter(u => (u.plan || 'free') === 'free').length;
  const pro = users.filter(u => u.plan === 'pro').length;
  const business = users.filter(u => u.plan === 'business').length;
  const failed = transactions.filter(tx => ['failed', 'filtered', 'blocked'].includes(String(tx.status || '').toLowerCase())).length;
  const revenue = await db.collection('platform_fees').limit(10000).get();
  const revenueTotal = revenue.docs.map(d => d.data()).filter(fee => {
    const t = timestampMillis(fee.timestamp); return t >= start.getTime() && t < end.getTime();
  }).reduce((sum, fee) => sum + Number(fee.amount || 0), 0);

  const metrics = {
    users: totalUsers, newUsers, transactions: transactions.length,
    volume: completed.reduce((sum, tx) => sum + Number(tx.amount || 0), 0),
    savings: sumType('savings'), withdrawals: sumType('withdrawal'), revenue: revenueTotal, failed,
    plans: {
      free, pro, business,
      freePct: totalUsers ? Math.round(free / totalUsers * 100) : 0,
      proPct: totalUsers ? Math.round(pro / totalUsers * 100) : 0,
      businessPct: totalUsers ? Math.round(business / totalUsers * 100) : 0
    }
  };
  return { monthLabel: start.toLocaleDateString('en-MW', { month: 'long', year: 'numeric' }), metrics, transactions };
}

export async function sendMonthlyAdminReport({ year, month, to }) {
  const report = await buildMonthlyAdminReport({ year, month });
  const recipient = to || process.env.ADMIN_REPORT_EMAIL;
  if (!recipient) { const e = new Error('Set ADMIN_REPORT_EMAIL before sending monthly admin reports.'); e.statusCode = 500; throw e; }
  const pdf = await buildMonthlyAdminPdf(report);
  const monthKey = `${year}-${String(month).padStart(2, '0')}`;
  const reportSignature = createHash('sha256')
    .update(pdf)
    .digest('hex')
    .slice(0, 32);
  const key = `admin-monthly-report/${monthKey}/${reportSignature}`;
  const result = await sendEmail({
    to: recipient,
    subject: `PocketVault monthly report — ${report.monthLabel}`,
    idempotencyKey: key,
    tags: [{ name: 'category', value: 'admin_report' }, { name: 'report_type', value: 'monthly' }],
    html: `<p style="font-family:Arial,sans-serif;color:#334155">Your PocketVault monthly platform report for <strong>${report.monthLabel}</strong> is attached.</p>`,
    text: `Your PocketVault monthly platform report for ${report.monthLabel} is attached.`,
    attachments: [{ filename: `pocketvault-monthly-report-${year}-${String(month).padStart(2, '0')}.pdf`, content: pdf }]
  });
  return { ...report, emailId: result?.id || null, recipient };
}
