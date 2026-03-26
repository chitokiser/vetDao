// /assets/js/firebase.js
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.7.0/firebase-app.js";
import { getFirestore } from "https://www.gstatic.com/firebasejs/10.7.0/firebase-firestore.js";
import { getAuth, signInAnonymously } from "https://www.gstatic.com/firebasejs/10.7.0/firebase-auth.js";
import { getStorage } from "https://www.gstatic.com/firebasejs/10.7.0/firebase-storage.js";

if (!window.SECRETS?.firebase) throw new Error("secrets.js 가 로드되지 않았습니다. assets/js/secrets.example.js 를 참고하세요.");
const firebaseConfig = window.SECRETS.firebase;

const app = initializeApp(firebaseConfig);

window.db      = getFirestore(app);
window.storage = getStorage(app);

const auth = getAuth(app);
window.auth = auth;

window.firebaseReady = (async () => {
  try {
    await signInAnonymously(auth);
  } catch (e) {
    console.warn("anon auth failed", e);
  }
  return true;
})();
