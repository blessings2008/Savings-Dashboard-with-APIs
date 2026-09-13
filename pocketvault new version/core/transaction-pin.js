import crypto from 'crypto';
import { db, FieldValue } from './firebase.js';

const PIN_LENGTH = 6;
const MAX_ATTEMPTS = 5;
const LOCK_MINUTES = 15;

function hashPin(pin, salt) {
  return crypto.scryptSync(pin, salt, 64).toString('hex');
}

export function validateTransactionPin(pin) {
  return typeof pin === 'string' && /^\d{6}$/.test(pin);
}

export async function setTransactionPin(uid, pin) {
  if (!validateTransactionPin(pin)) throw new Error('Transaction PIN must be exactly 6 digits.');
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = hashPin(pin, salt);
  await db.collection('users').doc(uid).set({
    transactionPin: { hash, salt, attempts: 0, lockedUntil: null, updatedAt: FieldValue.serverTimestamp() }
  }, { merge: true });
}

export async function verifyTransactionPin(uid, pin) {
  if (!validateTransactionPin(pin)) return { ok: false, code: 'INVALID_PIN', error: 'Enter your 6-digit Transaction PIN.' };
  const ref = db.collection('users').doc(uid);
  const snap = await ref.get();
  const data = snap.data() || {};
  const record = data.transactionPin;
  if (!record?.hash || !record?.salt) return { ok: false, code: 'PIN_NOT_SET', error: 'Set up your Transaction PIN before authorizing money movements.' };
  if (record.lockedUntil && Date.now() < Number(record.lockedUntil)) {
    const minutes = Math.max(1, Math.ceil((Number(record.lockedUntil) - Date.now()) / 60000));
    return { ok: false, code: 'PIN_LOCKED', error: `Too many failed attempts. Try again in ${minutes} minute${minutes === 1 ? '' : 's'}.` };
  }
  const candidate = hashPin(pin, record.salt);
  const valid = crypto.timingSafeEqual(Buffer.from(candidate, 'hex'), Buffer.from(record.hash, 'hex'));
  if (valid) {
    await ref.set({ transactionPin: { ...record, attempts: 0, lockedUntil: null, lastVerifiedAt: FieldValue.serverTimestamp() } }, { merge: true });
    return { ok: true };
  }
  const attempts = Number(record.attempts || 0) + 1;
  const lockedUntil = attempts >= MAX_ATTEMPTS ? Date.now() + LOCK_MINUTES * 60000 : null;
  await ref.set({ transactionPin: { ...record, attempts, lockedUntil } }, { merge: true });
  return { ok: false, code: lockedUntil ? 'PIN_LOCKED' : 'INVALID_PIN', error: lockedUntil ? `Too many failed attempts. Try again in ${LOCK_MINUTES} minutes.` : 'Incorrect Transaction PIN.' };
}
