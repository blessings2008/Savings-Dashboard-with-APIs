import crypto from 'crypto';
import { db, FieldValue } from './firebase.js';

const PIN_LENGTH = 6;
const MAX_ATTEMPTS = 5;
const LOCK_MINUTES = 15;

function hashPin(pin, salt) {
  return crypto.scryptSync(pin, salt, 64).toString('hex');
}

export function validateTransactionPin(pin) {
  return typeof pin === 'string' && new RegExp(`^\\d{${PIN_LENGTH}}$`).test(pin);
}

export async function hasTransactionPin(uid) {
  const snap = await db.collection('users').doc(uid).get();
  const record = snap.data()?.transactionPin;
  return Boolean(record?.hash && record?.salt);
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

  const now = Date.now();
  const lockedUntil = Number(record.lockedUntil || 0);
  if (lockedUntil > now) {
    const minutes = Math.max(1, Math.ceil((lockedUntil - now) / 60000));
    return { ok: false, code: 'PIN_LOCKED', error: `Too many failed attempts. Try again in ${minutes} minute${minutes === 1 ? '' : 's'}.` };
  }

  const candidate = hashPin(pin, record.salt);
  const stored = String(record.hash);
  const valid = /^[0-9a-f]{128}$/i.test(stored) && crypto.timingSafeEqual(
    Buffer.from(candidate, 'hex'),
    Buffer.from(stored, 'hex')
  );

  if (valid) {
    await ref.set({ transactionPin: { ...record, attempts: 0, lockedUntil: null, lastVerifiedAt: FieldValue.serverTimestamp() } }, { merge: true });
    return { ok: true };
  }

  // Serialize the failure update so concurrent bad attempts cannot lose increments.
  const result = await db.runTransaction(async tx => {
    const latest = await tx.get(ref);
    const latestRecord = latest.data()?.transactionPin;
    if (!latestRecord?.hash || !latestRecord?.salt) return { attempts: MAX_ATTEMPTS, lockedUntil: now + LOCK_MINUTES * 60000 };
    const latestLocked = Number(latestRecord.lockedUntil || 0);
    if (latestLocked > Date.now()) return { attempts: Number(latestRecord.attempts || MAX_ATTEMPTS), lockedUntil: latestLocked };
    const attempts = Number(latestRecord.attempts || 0) + 1;
    const nextLockedUntil = attempts >= MAX_ATTEMPTS ? Date.now() + LOCK_MINUTES * 60000 : null;
    tx.set(ref, { transactionPin: { ...latestRecord, attempts, lockedUntil: nextLockedUntil } }, { merge: true });
    return { attempts, lockedUntil: nextLockedUntil };
  });

  if (result.lockedUntil) return { ok: false, code: 'PIN_LOCKED', error: `Too many failed attempts. Try again in ${LOCK_MINUTES} minutes.` };
  return { ok: false, code: 'INVALID_PIN', error: 'Incorrect Transaction PIN.' };
}
