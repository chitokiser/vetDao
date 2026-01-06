// \assets\js\firebase.js
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.7.0/firebase-app.js";
import { getFirestore } from "https://www.gstatic.com/firebasejs/10.7.0/firebase-firestore.js";

const firebaseConfig = {
   apiKey: "AIzaSyD5RSdkYT4ibBxkz2gBXu0z_F-C_NgGRps",
    authDomain: "pawtube-42f90.firebaseapp.com",
    projectId: "pawtube-42f90",
    storageBucket: "pawtube-42f90.firebasestorage.app",
    messagingSenderId: "1041412280991",
    appId: "1:1041412280991:web:8dd0c41d7f98828bebc8aa",
    measurementId: "G-WFGNX1ZTMH"
};

const app = initializeApp(firebaseConfig);

export const db = getFirestore(app);
