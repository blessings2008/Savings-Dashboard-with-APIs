// PocketVault transactional email service.
// Resend is server-side only. Never expose RESEND_API_KEY to the browser.
import crypto from 'crypto';
import { Resend } from 'resend';
import { db, FieldValue, adminAuth } from '../core/firebase.js';
import { safeCompare } from '../core/middleware.js';

const apiKey = String(process.env.RESEND_API_KEY || '').trim();
const from = String(process.env.RESEND_FROM_EMAIL || 'PocketVault <onboarding@resend.dev>').trim();
const replyTo = String(process.env.RESEND_REPLY_TO_EMAIL || '').trim();
const appUrl = String(process.env.POCKETVAULT_APP_URL || 'https://savings-dashboard-with-apis-2-0.onrender.com').replace(/\/$/, '');
const resend = apiKey ? new Resend(apiKey) : null;
const OTP_TTL_MS = 10 * 60 * 1000;
const OTP_COOLDOWN_MS = 60 * 1000;
const OTP_MAX_ATTEMPTS = 5;
const OTP_SECRET = String(process.env.EMAIL_OTP_SECRET || process.env.FIREBASE_PROJECT_ID || 'pocketvault-otp-secret');

const escapeHtml = value => String(value ?? '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&#039;');

const normalizeRecipients = to => {
  const recipients = (Array.isArray(to) ? to : [to]).map(value => String(value || '').trim()).filter(Boolean);
  if (!recipients.length) { const e = new Error('Email requires at least one recipient.'); e.code = 'INVALID_EMAIL_RECIPIENT'; throw e; }
  const pattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  if (recipients.some(email => !pattern.test(email))) { const e = new Error('Email contains an invalid recipient address.'); e.code = 'INVALID_EMAIL_RECIPIENT'; throw e; }
  return recipients;
};

export function isEmailConfigured() { return Boolean(resend && from); }
export function getEmailStatus() { return { provider: 'resend', configured: isEmailConfigured(), from, replyTo: replyTo || null }; }

export async function sendEmail({ to, subject, html, text, idempotencyKey, tags = [], attachments = [] }) {
  if (!resend) { const e = new Error('Resend is not configured. Set RESEND_API_KEY on the server.'); e.code = 'RESEND_NOT_CONFIGURED'; throw e; }
  if (!subject || (!html && !text)) { const e = new Error('Email requires subject and html or text content.'); e.code = 'INVALID_EMAIL'; throw e; }
  const recipients = normalizeRecipients(to);
  const cleanSubject = String(subject).trim().slice(0, 200);
  const cleanKey = idempotencyKey ? String(idempotencyKey).trim().slice(0, 256) : null;
  const cleanTags = Array.isArray(tags) ? tags.filter(tag => tag?.name && tag?.value).map(tag => ({ name: String(tag.name).trim().slice(0, 256), value: String(tag.value).trim().slice(0, 256) })).slice(0, 10) : [];
  const cleanAttachments = Array.isArray(attachments) ? attachments.filter(file => file && (file.content || file.path)).map(file => ({ filename: String(file.filename || 'attachment.pdf').slice(0, 180), ...(file.content ? { content: file.content } : {}), ...(file.path ? { path: String(file.path) } : {}) })).slice(0, 5) : [];
  const payload = { from, to: recipients, subject: cleanSubject, ...(replyTo ? { replyTo } : {}), ...(cleanTags.length ? { tags: cleanTags } : {}), ...(cleanAttachments.length ? { attachments: cleanAttachments } : {}), ...(html ? { html: String(html) } : {}), ...(text ? { text: String(text) } : {}) };
  const { data, error } = cleanKey ? await resend.emails.send(payload, { idempotencyKey: cleanKey }) : await resend.emails.send(payload);
  if (error) { const wrapped = new Error(error.message || 'Resend email delivery failed.'); wrapped.code = error.name || error.statusCode || 'RESEND_ERROR'; wrapped.statusCode = error.statusCode || null; wrapped.details = error; throw wrapped; }
  return data;
}

function emailShell({ preheader, title, eyebrow, body, ctaLabel, ctaUrl }) {
  const safeUrl = escapeHtml(ctaUrl || appUrl);
  const cta = ctaLabel ? `<p style="margin:28px 0 8px"><a href="${safeUrl}" style="display:inline-block;background:#111827;color:#ffffff;text-decoration:none;font-weight:700;padding:13px 20px;border-radius:10px">${escapeHtml(ctaLabel)}</a></p>` : '';
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(title)}</title></head><body style="margin:0;background:#f4f7f6;font-family:Arial,Helvetica,sans-serif;color:#17202a"><div style="display:none;max-height:0;overflow:hidden;opacity:0">${escapeHtml(preheader)}</div><table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background:#f4f7f6;padding:28px 12px"><tr><td align="center"><table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width:620px;background:#ffffff;border:1px solid #e7ecea;border-radius:18px;overflow:hidden"><tr><td style="padding:24px 28px;background:#111827;color:#ffffff"><div style="font-size:18px;font-weight:800">PocketVault 🇲🇼</div><div style="font-size:12px;color:#cbd5e1;margin-top:4px">Smarter saving. Clearer progress.</div></td></tr><tr><td style="padding:32px 28px"><div style="font-size:12px;font-weight:800;letter-spacing:.08em;text-transform:uppercase;color:#64748b;margin-bottom:8px">${escapeHtml(eyebrow || 'PocketVault')}</div><h1 style="margin:0 0 18px;font-size:28px;line-height:1.2;color:#111827">${escapeHtml(title)}</h1>${body}${cta}</td></tr><tr><td style="padding:18px 28px;border-top:1px solid #edf1ef;color:#64748b;font-size:12px;line-height:1.6">You received this email because it relates to your PocketVault account.<br>© ${new Date().getFullYear()} PocketVault. Malawi.</td></tr></table></td></tr></table></body></html>`;
}

export function buildWelcomeEmail(name) {
  const safeName = escapeHtml(name || 'there');
  const text = `Hi ${name || 'there'},\n\nWelcome to PocketVault. Your account is ready.\n\nOpen PocketVault: ${appUrl}\n\n— PocketVault`;
  const html = emailShell({ preheader: 'Your PocketVault account is ready.', eyebrow: 'Welcome aboard', title: 'Your savings journey starts here.', body: `<p style="font-size:16px;line-height:1.7;margin:0 0 14px">Hi ${safeName},</p><p style="font-size:16px;line-height:1.7;margin:0 0 14px">Your PocketVault account is ready. You can now create savings goals, track your money and see your progress in one place.</p><div style="margin:22px 0;padding:16px 18px;background:#f0fdf4;border:1px solid #dcfce7;border-radius:12px;color:#166534;font-size:14px;line-height:1.6"><strong>Quick start:</strong> Create your first goal, give it a target and let PocketVault help you stay on track.</div>`, ctaLabel: 'Open PocketVault', ctaUrl: appUrl });
  return { text, html };
}

export function buildTransactionEmail({ type, amount, status = 'completed', reference = 'N/A' }) {
  const labels = { savings: 'Savings', withdrawal: 'Withdrawal', subscription: 'Subscription', merchant_payment: 'Merchant payment' };
  const label = labels[type] || 'Transaction'; const rawStatus = String(status).trim().slice(0, 40) || 'completed'; const rawReference = String(reference || 'N/A').trim().slice(0, 100); const formatted = `MWK ${Number(amount).toLocaleString()}`;
  const html = emailShell({ preheader: `${label} ${rawStatus} — ${formatted}`, eyebrow: 'Account activity', title: `${label} update`, body: `<p style="font-size:15px;line-height:1.6;margin:0 0 20px">Here is a summary of a recent activity on your PocketVault account.</p><table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="border:1px solid #e7ecea;border-radius:14px;overflow:hidden"><tr><td style="padding:16px 18px;color:#64748b;font-size:13px">Status</td><td align="right" style="padding:16px 18px;font-weight:700;color:#111827">${escapeHtml(rawStatus)}</td></tr><tr><td style="padding:16px 18px;border-top:1px solid #edf1ef;color:#64748b;font-size:13px">Amount</td><td align="right" style="padding:16px 18px;border-top:1px solid #edf1ef;font-size:18px;font-weight:800;color:#111827">${escapeHtml(formatted)}</td></tr><tr><td style="padding:16px 18px;border-top:1px solid #edf1ef;color:#64748b;font-size:13px">Reference</td><td align="right" style="padding:16px 18px;border-top:1px solid #edf1ef;font-size:13px;color:#111827">${escapeHtml(rawReference)}</td></tr></table>`, ctaLabel: 'View PocketVault', ctaUrl: appUrl });
  return { text: `${label} ${rawStatus}.\n\nAmount: ${formatted}\nReference: ${rawReference}\n\nOpen PocketVault: ${appUrl}\n\n— PocketVault`, html };
}

// ---------------- EMAIL OTP ----------------
function hashOtp(uid, code) { return crypto.createHmac('sha256', OTP_SECRET).update(`${uid}:${code}`).digest('hex'); }
function generateOtp() { return crypto.randomInt(100000, 1000000).toString(); }
function otpEmail(code) {
  const html = `<!doctype html><html><body style="margin:0;background:#f4f7f6;font-family:Arial,sans-serif;color:#17202a"><div style="max-width:560px;margin:32px auto;background:#fff;border:1px solid #e7ecea;border-radius:18px;overflow:hidden"><div style="padding:24px;background:#111827;color:#fff;font-size:19px;font-weight:800">PocketVault 🇲🇼</div><div style="padding:32px"><div style="font-size:12px;color:#64748b;font-weight:800;letter-spacing:.08em;text-transform:uppercase">Email verification</div><h1 style="font-size:27px;margin:8px 0 14px;color:#111827">Your verification code</h1><p style="font-size:15px;line-height:1.6;color:#475569">Use this one-time code to finish signing in to PocketVault.</p><div style="margin:24px 0;padding:20px;text-align:center;background:#f0fdf4;border:1px solid #dcfce7;border-radius:14px;font-size:34px;letter-spacing:9px;font-weight:800;color:#166534">${code}</div><p style="font-size:13px;color:#64748b;line-height:1.6">This code expires in 10 minutes. If you did not try to sign in, you can safely ignore this email.</p></div></div></body></html>`;
  return { html, text: `Your PocketVault verification code is ${code}. It expires in 10 minutes.` };
}

async function getOtpUser(uid) {
  const user = await adminAuth.getUser(uid);
  if (!user.email) { const e = new Error('Your account does not have an email address.'); e.statusCode = 400; throw e; }
  return user;
}

export async function emailOtpStatus(uid) {
  const user = await getOtpUser(uid);
  const snap = await db.collection('users').doc(uid).get();
  const data = snap.data() || {};
  return { verified: Boolean(user.emailVerified || data.emailOtpVerifiedAt), email: user.email.replace(/^(.{2}).*(@.*)$/, '$1••••$2') };
}

export async function sendEmailOtp(uid) {
  const user = await getOtpUser(uid);
  if (user.emailVerified) return { verified: true, sent: false, reason: 'already_verified' };
  const ref = db.collection('email_otps').doc(uid);
  const existing = await ref.get();
  const current = existing.data() || {};
  if (current.lastSentAt && Date.now() - Number(current.lastSentAt) < OTP_COOLDOWN_MS) {
    const retryAfter = Math.ceil((OTP_COOLDOWN_MS - (Date.now() - Number(current.lastSentAt))) / 1000);
    const e = new Error(`Please wait ${retryAfter}s before requesting another code.`); e.statusCode = 429; e.retryAfter = retryAfter; throw e;
  }
  const code = generateOtp();
  await ref.set({ codeHash: hashOtp(uid, code), expiresAt: Date.now() + OTP_TTL_MS, attempts: 0, lastSentAt: Date.now() });
  try {
    const result = await sendEmail({
      to: user.email,
      subject: 'Your PocketVault verification code',
      idempotencyKey: `email-otp/${uid}/${Math.floor(Date.now() / OTP_COOLDOWN_MS)}`,
      tags: [{ name: 'category', value: 'email_verification' }, { name: 'product', value: 'pocketvault' }],
      ...otpEmail(code)
    });
    return { verified: false, sent: true, id: result?.id || null, expiresIn: OTP_TTL_MS / 1000 };
  } catch (error) { await ref.delete(); throw error; }
}

export async function verifyEmailOtp(uid, code) {
  const cleanCode = String(code || '').replace(/\D/g, '');
  if (!/^\d{6}$/.test(cleanCode)) { const e = new Error('Enter the 6-digit verification code.'); e.statusCode = 400; throw e; }
  const ref = db.collection('email_otps').doc(uid);
  const snap = await ref.get(); const otp = snap.data();
  if (!otp) { const e = new Error('No active verification code. Request a new one.'); e.statusCode = 400; throw e; }
  if (Number(otp.expiresAt) < Date.now()) { await ref.delete(); const e = new Error('That code has expired. Request a new one.'); e.statusCode = 400; throw e; }
  if (Number(otp.attempts || 0) >= OTP_MAX_ATTEMPTS) { await ref.delete(); const e = new Error('Too many incorrect attempts. Request a new code.'); e.statusCode = 429; throw e; }
  if (!safeCompare(hashOtp(uid, cleanCode), String(otp.codeHash || ''))) {
    await ref.update({ attempts: FieldValue.increment(1) });
    const remaining = Math.max(0, OTP_MAX_ATTEMPTS - Number(otp.attempts || 0) - 1);
    const e = new Error(`Incorrect code. ${remaining} attempt${remaining === 1 ? '' : 's'} remaining.`); e.statusCode = 400; throw e;
  }
  await adminAuth.updateUser(uid, { emailVerified: true });
  await db.collection('users').doc(uid).set({ emailOtpVerifiedAt: FieldValue.serverTimestamp(), emailVerificationMethod: 'otp' }, { merge: true });
  await ref.delete();
  return { verified: true };
}
