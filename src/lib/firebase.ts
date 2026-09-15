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

// Default config loaded from firebase-applet-config.json or environment variables
const env = (import.meta as any).env || {};

export const firebaseConfig = {
  apiKey: env.VITE_FIREBASE_API_KEY || 'AIzaSyAaPeUclSEKMGfX_TeECDtK4IXaTnpHXUU',
  authDomain: env.VITE_FIREBASE_AUTH_DOMAIN || 'gen-lang-client-0122011124.firebaseapp.com',
  projectId: env.VITE_FIREBASE_PROJECT_ID || 'gen-lang-client-0122011124',
  storageBucket: env.VITE_FIREBASE_STORAGE_BUCKET || 'gen-lang-client-0122011124.firebasestorage.app',
  messagingSenderId: env.VITE_FIREBASE_MESSAGING_SENDER_ID || '599754889812',
  appId: env.VITE_FIREBASE_APP_ID || '1:599754889812:web:2daf28116eb072ce88abc1',
};

// Initialize Firebase App singleton
export const app = getApps().length === 0 ? initializeApp(firebaseConfig) : getApp();

// Firebase Auth & Firestore
export const auth = getAuth(app);
export const googleProvider = new GoogleAuthProvider();
googleProvider.setCustomParameters({ prompt: 'select_account' });

// Initialize Firestore
export const db = getFirestore(app);

/**
 * Sync user profile to Firestore `/users/{uid}`
 */
export async function syncUserToFirestore(user: FirebaseUser, customUsername?: string) {
  try {
    const userRef = doc(db, 'users', user.uid);
    const existing = await getDoc(userRef);
    const username = customUsername || user.displayName || user.email?.split('@')[0] || `User_${user.uid.slice(0, 6)}`;
    
    if (!existing.exists()) {
      await setDoc(userRef, {
        id: user.uid,
        username,
        email: user.email || '',
        photoURL: user.photoURL || '',
        isAdmin: false,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });
    } else {
      await setDoc(
        userRef,
        {
          updatedAt: new Date().toISOString(),
          ...(user.photoURL ? { photoURL: user.photoURL } : {}),
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
