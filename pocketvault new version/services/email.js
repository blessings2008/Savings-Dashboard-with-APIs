// PocketVault transactional email service.
// Resend is server-side only. Never expose RESEND_API_KEY to the browser.
import { Resend } from 'resend';

const apiKey = process.env.RESEND_API_KEY;
const from = process.env.RESEND_FROM_EMAIL || 'PocketVault <onboarding@resend.dev>';

const resend = apiKey ? new Resend(apiKey) : null;

export function isEmailConfigured() {
  return Boolean(apiKey);
}

export async function sendEmail({ to, subject, html, text }) {
  if (!resend) {
    const error = new Error('Resend is not configured. Set RESEND_API_KEY on the server.');
    error.code = 'RESEND_NOT_CONFIGURED';
    throw error;
  }

  if (!to || !subject || (!html && !text)) {
    const error = new Error('Email requires to, subject, and html or text content.');
    error.code = 'INVALID_EMAIL';
    throw error;
  }

  const { data, error } = await resend.emails.send({
    from,
    to: Array.isArray(to) ? to : [to],
    subject,
    ...(html ? { html } : {}),
    ...(text ? { text } : {})
  });

  if (error) {
    const wrapped = new Error(error.message || 'Resend email delivery failed.');
    wrapped.code = error.name || 'RESEND_ERROR';
    wrapped.details = error;
    throw wrapped;
  }

  return data;
}
