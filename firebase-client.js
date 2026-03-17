import {
  getApp,
  getApps,
  initializeApp,
} from "https://www.gstatic.com/firebasejs/11.7.3/firebase-app.js";
import {
  createUserWithEmailAndPassword,
  getAuth,
  getRedirectResult,
  GoogleAuthProvider,
  onAuthStateChanged,
  setPersistence,
  browserLocalPersistence,
  signInWithPopup,
  signInWithRedirect,
  signInWithEmailAndPassword,
  signOut,
  updateProfile,
} from "https://www.gstatic.com/firebasejs/11.7.3/firebase-auth.js";
import {
  doc,
  getDoc,
  getFirestore,
  onSnapshot,
  setDoc,
} from "https://www.gstatic.com/firebasejs/11.7.3/firebase-firestore.js";
import { firebaseConfig, firebaseSettings } from "./firebase-config.js";

function hasCompleteConfig() {
  return Object.values(firebaseConfig).every(Boolean);
}

export function isFirebaseEnabled() {
  return firebaseSettings.enabled && hasCompleteConfig();
}

let firestore = null;
let authInstance = null;

function getStateDoc() {
  if (!isFirebaseEnabled()) {
    return null;
  }

  const app = getFirebaseApp();
  if (!firestore) {
    firestore = getFirestore(app);
  }

  return doc(
    firestore,
    firebaseSettings.gameCollection,
    firebaseSettings.gameDocument
  );
}

function getFirebaseApp() {
  if (getApps().length) {
    return getApp();
  }
  return initializeApp(firebaseConfig);
}

function getFirebaseAuth() {
  if (!isFirebaseEnabled()) {
    return null;
  }

  if (!authInstance) {
    authInstance = getAuth(getFirebaseApp());
    setPersistence(authInstance, browserLocalPersistence).catch(() => {});
  }

  return authInstance;
}

export async function fetchRemoteState() {
  const stateDoc = getStateDoc();
  if (!stateDoc) {
    return null;
  }

  const snapshot = await getDoc(stateDoc);
  if (!snapshot.exists()) {
    return null;
  }

  return snapshot.data();
}

export async function persistRemoteState(payload) {
  const stateDoc = getStateDoc();
  if (!stateDoc) {
    return;
  }

  await setDoc(stateDoc, payload, { merge: false });
}

export function subscribeToRemoteState(callback) {
  const stateDoc = getStateDoc();
  if (!stateDoc) {
    return () => {};
  }

  return onSnapshot(stateDoc, (snapshot) => {
    if (!snapshot.exists()) {
      return;
    }
    callback(snapshot.data());
  });
}

export function subscribeToAuthState(callback) {
  const auth = getFirebaseAuth();
  if (!auth) {
    callback(null);
    return () => {};
  }

  return onAuthStateChanged(auth, callback);
}

export async function registerWithEmailPassword({ name, email, password }) {
  const auth = getFirebaseAuth();
  const credential = await createUserWithEmailAndPassword(auth, email, password);
  if (name) {
    await updateProfile(credential.user, { displayName: name });
  }
  return credential.user;
}

export async function loginWithEmailPassword({ email, password }) {
  const auth = getFirebaseAuth();
  const credential = await signInWithEmailAndPassword(auth, email, password);
  return credential.user;
}

export async function loginWithGoogle() {
  const auth = getFirebaseAuth();
  const provider = new GoogleAuthProvider();
  const isMobileViewport = window.matchMedia("(max-width: 820px)").matches;

  if (isMobileViewport) {
    await signInWithRedirect(auth, provider);
    return null;
  }

  const credential = await signInWithPopup(auth, provider);
  return credential.user;
}

export async function handleGoogleRedirectResult() {
  const auth = getFirebaseAuth();
  const result = await getRedirectResult(auth);
  return result?.user || null;
}

export async function logoutFirebaseUser() {
  const auth = getFirebaseAuth();
  if (!auth) {
    return;
  }
  await signOut(auth);
}
