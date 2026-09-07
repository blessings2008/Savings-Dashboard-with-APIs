// PocketVault transactional email service.
// Resend is server-side only. Never expose RESEND_API_KEY to the browser.
import { Resend } from 'resend';

const apiKey = String(process.env.RESEND_API_KEY || '').trim();
const from = String(process.env.RESEND_FROM_EMAIL || 'PocketVault <onboarding@resend.dev>').trim();
const replyTo = String(process.env.RESEND_REPLY_TO_EMAIL || '').trim();
const appUrl = String(process.env.POCKETVAULT_APP_URL || 'https://savings-dashboard-with-apis-2-0.onrender.com').replace(/\/$/, '');
const resend = apiKey ? new Resend(apiKey) : null;

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
  const cleanTags = Array.isArray(tags) ? tags.filter(tag => tag?.name && tag?.value).map(tag => ({
    name: String(tag.name).trim().slice(0, 256), value: String(tag.value).trim().slice(0, 256)
  })).slice(0, 10) : [];
  const cleanAttachments = Array.isArray(attachments) ? attachments.filter(file => file && (file.content || file.path)).map(file => ({
    filename: String(file.filename || 'attachment.pdf').slice(0, 180),
    ...(file.content ? { content: file.content } : {}),
    ...(file.path ? { path: String(file.path) } : {})
  })).slice(0, 5) : [];

  const payload = {
    from, to: recipients, subject: cleanSubject,
    ...(replyTo ? { replyTo } : {}),
    ...(cleanTags.length ? { tags: cleanTags } : {}),
    ...(cleanAttachments.length ? { attachments: cleanAttachments } : {}),
    ...(html ? { html: String(html) } : {}), ...(text ? { text: String(text) } : {})
  };

  const { data, error } = cleanKey ? await resend.emails.send(payload, { idempotencyKey: cleanKey }) : await resend.emails.send(payload);
  if (error) {
    const wrapped = new Error(error.message || 'Resend email delivery failed.');
    wrapped.code = error.name || error.statusCode || 'RESEND_ERROR'; wrapped.statusCode = error.statusCode || null; wrapped.details = error; throw wrapped;
  }
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
