// PocketVault Firebase Admin init.
// Moved verbatim out of the top of the old monolithic server.js.
// ESM modules execute exactly once and are cached, so importing this
// first (as server.js does) still guarantees the same fail-fast
// behavior as before: if credentials are missing, process.exit(1)
// runs before any route or job ever gets a chance to touch `db`.
import { initializeApp, cert } from 'firebase-admin/app';
import { readFileSync, existsSync } from 'fs';
import { getFirestore, FieldValue } from 'firebase-admin/firestore';
import { getAuth } from 'firebase-admin/auth';

// ----------------------------
// FIREBASE ADMIN INIT
// ----------------------------
let firebaseCredential;

const SECRET_FILE_PATH = '/etc/secrets/serviceAccountKey.json';
const LOCAL_FILE_PATH = './serviceAccountKey.json';

// ----------------------------
// DEBUG: Show what credential sources are available
// ----------------------------
console.log('🔍 Checking Firebase credential sources:');
console.log('   /etc/secrets/serviceAccountKey.json exists:', existsSync(SECRET_FILE_PATH));
console.log('   ./serviceAccountKey.json exists:', existsSync(LOCAL_FILE_PATH));
console.log('   GOOGLE_APPLICATION_CREDENTIALS_JSON set:', !!process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON);
console.log('   FIREBASE_PROJECT_ID set:', !!process.env.FIREBASE_PROJECT_ID, process.env.FIREBASE_PROJECT_ID || '');
console.log('   FIREBASE_CLIENT_EMAIL set:', !!process.env.FIREBASE_CLIENT_EMAIL);
console.log('   FIREBASE_PRIVATE_KEY set:', !!process.env.FIREBASE_PRIVATE_KEY);
console.log('   FIREBASE_PRIVATE_KEY length:', (process.env.FIREBASE_PRIVATE_KEY || '').length);

// List what's actually in /etc/secrets if it exists
try {
  if (existsSync('/etc/secrets')) {
    const fs = await import('fs');
    const files = fs.readdirSync('/etc/secrets');
    console.log('   Files in /etc/secrets:', files);
  } else {
    console.log('   /etc/secrets directory does not exist');
  }
} catch (e) {
  console.log('   Could not read /etc/secrets:', e.message);
}

if (existsSync(SECRET_FILE_PATH)) {
  const raw = readFileSync(SECRET_FILE_PATH, 'utf8');
  const serviceAccount = JSON.parse(raw);
  console.log('   Loaded keys from secret file:', Object.keys(serviceAccount));
  if (!serviceAccount.private_key) {
    console.error('❌ Secret file is missing private_key field');
    process.exit(1);
  }
  firebaseCredential = cert(serviceAccount);
  console.log('✅ Firebase loaded from Render secret file');
} else if (existsSync(LOCAL_FILE_PATH)) {
  const serviceAccount = JSON.parse(readFileSync(LOCAL_FILE_PATH, 'utf8'));
  firebaseCredential = cert(serviceAccount);
  console.log('✅ Firebase loaded from local file');
} else if (process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON) {
  try {
    const serviceAccount = JSON.parse(process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON);
    console.log('   Loaded keys from env JSON:', Object.keys(serviceAccount));
    if (!serviceAccount.private_key) throw new Error('private_key missing from JSON');
    firebaseCredential = cert(serviceAccount);
    console.log('✅ Firebase loaded from env JSON');
  } catch (e) {
    console.error('❌ Failed to parse GOOGLE_APPLICATION_CREDENTIALS_JSON:', e.message);
    process.exit(1);
  }
} else if (process.env.FIREBASE_PROJECT_ID && process.env.FIREBASE_PRIVATE_KEY) {
  firebaseCredential = cert({
    projectId: process.env.FIREBASE_PROJECT_ID,
    clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
    privateKey: process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n'),
  });
  console.log('✅ Firebase loaded from individual env vars');
} else {
  console.error('❌ No valid Firebase credentials found.');
  console.error('   Either add a Secret File named "serviceAccountKey.json" on Render,');
  console.error('   or set FIREBASE_PROJECT_ID + FIREBASE_CLIENT_EMAIL + FIREBASE_PRIVATE_KEY env vars.');
  process.exit(1);
}

const firebaseApp = initializeApp({ credential: firebaseCredential });

export const db = getFirestore();
export const adminAuth = getAuth();
export { FieldValue };

// ----------------------------
// GCP ACCESS TOKEN — for calling Google APIs the Firebase Admin SDK
// itself doesn't wrap, like the Firestore Admin REST API used for
// manual backup exports (see helpers.js's triggerFirestoreExport).
// Reuses the exact same service account credentials already loaded
// above — no separate auth setup needed. The credential object
// caches and refreshes the token internally, so this is safe to
// call on every export request rather than needing its own cache.
// ----------------------------
export async function getGcpAccessToken() {
  const { access_token } = await firebaseApp.options.credential.getAccessToken();
  return access_token;
}

export function getFirebaseProjectId() {
  return firebaseApp.options.credential.projectId
    || process.env.FIREBASE_PROJECT_ID
    || firebaseApp.options.projectId
    || null;
}

// ----------------------------
// BOOT-TIME ENVIRONMENT VALIDATION
// PRODUCTION FIX #8: previously, missing ADMIN_SECRET or other
// critical config only surfaced as a warning buried near the end of
// a long startup log, or as a confusing failure deep inside a
// request handler much later. This does one consolidated pass right
// after Firebase is confirmed working, and refuses to boot at all
// if something genuinely required is missing — fail fast and loud
// at deploy time, not silently at 2am when a real user hits it.
//
// Distinguishes REQUIRED (server won't start without these) from
// RECOMMENDED (server starts, but logs a loud warning) — payment
// provider credentials are recommended rather than required, since
// running in mock mode without them is a legitimate, intentional
// state during development.
// ----------------------------
export function validateEnvironment() {
  const missingRequired = [];
  if (!process.env.ADMIN_SECRET) missingRequired.push('ADMIN_SECRET');

  if (missingRequired.length > 0) {
    console.error('❌ FATAL: Missing required environment variables:', missingRequired.join(', '));
    console.error('   The server will not start until these are set in Render → Environment.');
    process.exit(1);
  }

  const warnings = [];
  if (!process.env.AIRTEL_CLIENT_ID && !process.env.PAYCHANGU_SECRET_KEY) {
    warnings.push('Neither AIRTEL_CLIENT_ID nor PAYCHANGU_SECRET_KEY set — running in mock mode, no real money will move.');
  }
  if (!process.env.ANTHROPIC_API_KEY && !process.env.GEMINI_API_KEY && !process.env.GROQ_API_KEY) {
    warnings.push('No AI provider key set — admin AI features will be unavailable.');
  }
  warnings.forEach(w => console.warn(`⚠️  ${w}`));
}
