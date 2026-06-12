import { initializeApp }
from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";

import {
  getAuth,
  signInWithEmailAndPassword,
  createUserWithEmailAndPassword,
  signInWithPopup,
  signInWithRedirect,
  getRedirectResult,
  GoogleAuthProvider,
  signOut,
  onAuthStateChanged
}
from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";

const firebaseConfig = {
  apiKey: "AIzaSyC-1g6QcAs2U64x6RUP2tGdo8b9hJQg3_k",
  authDomain: "money-saver-e0504.firebaseapp.com",
  projectId: "money-saver-e0504",
  storageBucket: "money-saver-e0504.firebasestorage.app",
  messagingSenderId: "414713997121",
  appId: "1:414713997121:web:7d244d6f4b23d1dfa0a3c0",
  measurementId: "G-2N6J2DR63X"
};

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const googleProvider = new GoogleAuthProvider();

export {
  auth,
  signInWithEmailAndPassword,
  createUserWithEmailAndPassword,
  signInWithPopup,
  signInWithRedirect,
  getRedirectResult,
  googleProvider,
  signOut,
  onAuthStateChanged
};
