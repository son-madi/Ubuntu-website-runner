/// <reference types="vite/client" />
import { initializeApp, getApps, getApp } from 'firebase/app';
import {
  getAuth,
  GoogleAuthProvider,
  signInWithPopup,
  signInWithEmailAndPassword,
  createUserWithEmailAndPassword,
  signOut as firebaseSignOut,
  onAuthStateChanged,
  updateProfile,
  User as FirebaseUser,
} from 'firebase/auth';
import {
  getFirestore,
  doc,
  setDoc,
  getDoc,
  deleteDoc,
} from 'firebase/firestore';
import firebaseConfigJson from '../../firebase-applet-config.json';

const env = (import.meta as any).env || {};

export const firebaseConfig = {
  apiKey: env.VITE_FIREBASE_API_KEY || firebaseConfigJson.apiKey,
  authDomain: env.VITE_FIREBASE_AUTH_DOMAIN || firebaseConfigJson.authDomain,
  projectId: env.VITE_FIREBASE_PROJECT_ID || firebaseConfigJson.projectId,
  storageBucket: env.VITE_FIREBASE_STORAGE_BUCKET || firebaseConfigJson.storageBucket,
  messagingSenderId: env.VITE_FIREBASE_MESSAGING_SENDER_ID || firebaseConfigJson.messagingSenderId,
  appId: env.VITE_FIREBASE_APP_ID || firebaseConfigJson.appId,
};

// Initialize Firebase App singleton
export const app = getApps().length === 0 ? initializeApp(firebaseConfig) : getApp();

// Firebase Auth & Firestore
export const auth = getAuth(app);
export const googleProvider = new GoogleAuthProvider();
googleProvider.setCustomParameters({ prompt: 'select_account' });

// Initialize Firestore with specific database ID if defined in configuration
export const db = firebaseConfigJson.firestoreDatabaseId && firebaseConfigJson.firestoreDatabaseId !== '(default)'
  ? getFirestore(app, firebaseConfigJson.firestoreDatabaseId)
  : getFirestore(app);

/**
 * Sync user profile to Firestore `/users/{uid}`
 */
export async function syncUserToFirestore(user: FirebaseUser, customUsername?: string) {
  try {
    const userRef = doc(db, 'users', user.uid);
    const existing = await getDoc(userRef);
    const username = customUsername || user.displayName || user.email?.split('@')[0] || `User_${user.uid.slice(0, 6)}`;
    const emailLower = (user.email || '').toLowerCase();
    const isAdmin =
      emailLower === 'shifinkallan16@gmail.com' ||
      emailLower === 'gamershifin75@gmail.com' ||
      emailLower === 'shifin67e@gmail.com' ||
      username.toLowerCase() === 'shifin';
    
    if (!existing.exists()) {
      await setDoc(userRef, {
        id: user.uid,
        username,
        email: user.email || '',
        photoURL: user.photoURL || '',
        isAdmin,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });
    } else {
      await setDoc(
        userRef,
        {
          updatedAt: new Date().toISOString(),
          ...(user.photoURL ? { photoURL: user.photoURL } : {}),
          ...(isAdmin ? { isAdmin: true } : {}),
        },
        { merge: true }
      );
    }
  } catch (err) {
    console.warn('Firestore user sync notice:', err);
  }
}

export async function deleteUserFromFirestore(userId: string) {
  try {
    const userRef = doc(db, 'users', userId);
    await deleteDoc(userRef);
  } catch (err) {
    console.debug('Firestore user deletion notice:', err);
  }
}

export {
  signInWithPopup,
  signInWithEmailAndPassword,
  createUserWithEmailAndPassword,
  firebaseSignOut,
  onAuthStateChanged,
  updateProfile,
};
