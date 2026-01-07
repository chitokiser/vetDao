import { initializeApp } from "https://www.gstatic.com/firebasejs/10.7.0/firebase-app.js";
import { getFirestore } from "https://www.gstatic.com/firebasejs/10.7.0/firebase-firestore.js";
import { getAuth, signInAnonymously } from "https://www.gstatic.com/firebasejs/10.7.0/firebase-auth.js";

const firebaseConfig = {
  apiKey: "AIzaSyD5RSdkYT4ibBxkz2gBXu0z_F-C_NgGRps",
  authDomain: "pawtube-42f90.firebaseapp.com",
  projectId: "pawtube-42f90",
  storageBucket: "pawtube-42f90.firebasestorage.app",
  messagingSenderId: "1041412280991",
  appId: "1:1041412280991:web:8dd0c41d7f98828bebc8aa",
};

const app = initializeApp(firebaseConfig);

window.db = getFirestore(app);

const auth = getAuth(app);
window.auth = auth;

// 🔑 핵심
window.firebaseReady = (async () => {
  try {
    await signInAnonymously(auth);
  } catch (e) {
    console.warn("anon auth failed", e);
  }
  return true;
})();
