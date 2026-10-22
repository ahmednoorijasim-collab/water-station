import { initializeApp, deleteApp } from 'firebase/app';
import {
  getAuth, initializeAuth, indexedDBLocalPersistence, browserLocalPersistence, inMemoryPersistence,
  signInWithEmailAndPassword, createUserWithEmailAndPassword, signOut, onAuthStateChanged, deleteUser
} from 'firebase/auth';
import {
  initializeFirestore, persistentLocalCache, persistentSingleTabManager, memoryLocalCache,
  doc, getDoc, setDoc, updateDoc, addDoc, deleteDoc, collection, query, where, orderBy, limit,
  onSnapshot, writeBatch, serverTimestamp, Timestamp, getCountFromServer, getDocs
} from 'firebase/firestore';

export const firebaseConfig = {
  apiKey: 'AIzaSyAxwpH7y7q1fJr-1apJhRmaoFff265cyPc',
  authDomain: 'waterapp-9cecd.firebaseapp.com',
  projectId: 'waterapp-9cecd',
  storageBucket: 'waterapp-9cecd.firebasestorage.app',
  messagingSenderId: '177562479106',
  appId: '1:177562479106:web:3fca6852e1d7ac09d1d51b'
};

export const ADMIN_EMAIL = 'admin@waterapp.local';
export const tankEmail = id => 't' + id + '@waterapp.local';
export const carEmail = n => 'car' + n + '@waterapp.local';

export const app = initializeApp(firebaseConfig);
export const auth = initializeAuth(app, { persistence: [indexedDBLocalPersistence, browserLocalPersistence] });

let cache;
try { cache = persistentLocalCache({ tabManager: persistentSingleTabManager() }); }
catch { cache = memoryLocalCache(); }
export const db = initializeFirestore(app, { localCache: cache, experimentalAutoDetectLongPolling: true });

// Create another person's login without signing the admin out (a second, throw-away Firebase app).
export async function createLogin(email, password) {
  const tmp = initializeApp(firebaseConfig, 'tmp-' + Date.now());
  try {
    const a = initializeAuth(tmp, { persistence: inMemoryPersistence });
    const cred = await createUserWithEmailAndPassword(a, email, password);
    const uid = cred.user.uid;
    await signOut(a);
    return uid;
  } finally {
    await deleteApp(tmp).catch(() => {});
  }
}

export {
  signInWithEmailAndPassword, createUserWithEmailAndPassword, signOut, onAuthStateChanged, deleteUser,
  doc, getDoc, setDoc, updateDoc, addDoc, deleteDoc, collection, query, where, orderBy, limit,
  onSnapshot, writeBatch, serverTimestamp, Timestamp, getCountFromServer, getDocs
};
