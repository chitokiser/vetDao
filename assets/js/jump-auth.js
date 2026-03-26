// /assets/js/jump-auth.js
// Jump 수탁 지갑 Firebase 인증 모듈
// 동적 로드 방식: header-wallet.js가 필요할 때 loadScript()로 불러옴

(function () {
  'use strict';

  const FIREBASE_CONFIG = {
    apiKey:            "AIzaSyD6oGXWcQIAa46ZiO6E9fBWOXqiNCAL4-c",
    authDomain:        "jumper-b15aa.firebaseapp.com",
    projectId:         "jumper-b15aa",
    storageBucket:     "jumper-b15aa.firebasestorage.app",
    messagingSenderId: "1051842479371",
    appId:             "1:1051842479371:web:cd0dca2c1eab0e44b58e0e",
    measurementId:     "G-0EGPWQ3JP0",
  };

  const JUMP_API     = 'https://us-central1-jumper-b15aa.cloudfunctions.net/externalApi';
  const JUMP_API_KEY = '3fd9afc326ff3f687197f3fbc8f746133d513e5f3237a54a94cd87a3dd3b56cf';

  // ── Firebase 초기화 (중복 방지) ────────────────────────────────────────
  let _initialized = false;
  function ensureInit() {
    if (_initialized) return;
    if (typeof firebase === 'undefined') throw new Error('Firebase SDK가 로드되지 않았습니다.');
    if (!firebase.apps || !firebase.apps.length) {
      firebase.initializeApp(FIREBASE_CONFIG);
    }
    _initialized = true;
  }

  async function getAuth() {
    for (let i = 0; i < 30; i++) {
      if (typeof firebase.auth === 'function') return firebase.auth();
      if (firebase.auth && typeof firebase.auth.getRedirectResult === 'function') return firebase.auth;
      await new Promise(r => setTimeout(r, 100));
    }
    throw new Error('Firebase Auth SDK가 초기화되지 않았습니다.');
  }

  // ── Jump API: 사용자 지갑 확인 ─────────────────────────────────────────
  async function apiVerifyUser(idToken) {
    const res = await fetch(JUMP_API + '/verifyUser', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userToken: idToken, apiKey: JUMP_API_KEY }),
    });
    if (!res.ok) {
      const txt = await res.text().catch(() => '');
      throw new Error('Jump verifyUser 실패 (' + res.status + '): ' + txt);
    }
    return res.json();
  }

  // ── Jump API: 메시지 서명 ──────────────────────────────────────────────
  async function apiSignMessage(idToken, message) {
    const res = await fetch(JUMP_API + '/signMessage', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userToken: idToken, message, apiKey: JUMP_API_KEY }),
    });
    if (!res.ok) {
      const txt = await res.text().catch(() => '');
      throw new Error('Jump signMessage 실패 (' + res.status + '): ' + txt);
    }
    return res.json();
  }

  // ── Jump API: 트랜잭션 서명 + 브로드캐스트 ────────────────────────────
  async function apiSignTransaction(idToken, tx) {
    const res = await fetch(JUMP_API + '/signTransaction', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Api-Key': JUMP_API_KEY },
      body: JSON.stringify({ idToken, tx, apiKey: JUMP_API_KEY }),
    });
    if (!res.ok) {
      const txt = await res.text().catch(() => '');
      throw new Error('Jump signTransaction 실패 (' + res.status + '): ' + txt);
    }
    return res.json();
  }

  // ── 공통: fbUser → jumpWallet 설정 ─────────────────────────────────────
  async function setupWallet(fbUser) {
    const idToken = await fbUser.getIdToken();
    const info    = await apiVerifyUser(idToken);
    console.log('[Jump] verifyUser 응답:', JSON.stringify(info));

    window.jumpWallet = {
      type:    'jump',
      address: (info.data || info).walletAddress || (info.data || info).address,
      email:   (info.data || info).email   || fbUser.email,
      name:    (info.data || info).name    || fbUser.displayName,
      _fbUser: fbUser,
      async getIdToken() { return fbUser.getIdToken(true); },
      async signMsg(message) {
        const token = await this.getIdToken();
        return apiSignMessage(token, message);
      },
    };
    return window.jumpWallet;
  }

  // ── Google 팝업 로그인 ────────────────────────────────────────────────
  let _popupInProgress = false;
  async function login() {
    if (_popupInProgress) return;
    _popupInProgress = true;
    try {
      ensureInit();
      const auth = await getAuth();
      const GProvider = firebase.auth.GoogleAuthProvider;
      if (!GProvider) throw new Error('GoogleAuthProvider를 찾을 수 없습니다.');
      const result = await auth.signInWithPopup(new GProvider());
      return setupWallet(result.user);
    } finally {
      _popupInProgress = false;
    }
  }

  // ── 로그아웃 ──────────────────────────────────────────────────────────
  async function logout() {
    try { ensureInit(); } catch { /* Firebase 미초기화면 스킵 */ }
    if (typeof firebase !== 'undefined') {
      await (await getAuth()).signOut().catch(() => {});
    }
    window.jumpWallet = null;
    location.reload();
  }

  // ── no-op (redirect 미사용) ───────────────────────────────────────────
  function checkRedirect() {}

  // ── 세션 자동 복원 (페이지 이동 후에도 로그인 유지) ─────────────────────
  // Firebase Auth는 IndexedDB에 세션을 저장하므로,
  // onAuthStateChanged로 이미 로그인된 유저를 감지해 jumpWallet을 재설정한다.
  async function autoRestore() {
    try {
      ensureInit();
      const auth = await getAuth();
      return new Promise((resolve) => {
        const unsubscribe = auth.onAuthStateChanged(async (user) => {
          unsubscribe(); // 최초 1회만 확인
          if (user) {
            try {
              const wallet = await setupWallet(user);
              resolve(wallet);
            } catch (e) {
              console.warn('[Jump] autoRestore setupWallet 실패:', e);
              resolve(null);
            }
          } else {
            resolve(null);
          }
        });
      });
    } catch (e) {
      console.warn('[Jump] autoRestore 오류:', e);
      return null;
    }
  }

  // ── 전역 노출 ─────────────────────────────────────────────────────────
  window.jumpLogin         = login;
  window.jumpLogout        = logout;
  window.jumpSignTx        = apiSignTransaction;
  window.jumpCheckRedirect = checkRedirect;
  window.jumpAutoRestore   = autoRestore;
})();
