// /assets/js/pages/profile.js
import {
  doc, getDoc, setDoc, serverTimestamp,
} from "https://www.gstatic.com/firebasejs/10.7.0/firebase-firestore.js";

await window.firebaseReady;

const db = window.db;
const $  = (id) => document.getElementById(id);

let userAddress = null;

// ── Helpers ───────────────────────────────────────────────────────────────────
function showNote(msg, isErr = false) {
  const el = $("note");
  if (!el) return;
  el.style.display = msg ? "block" : "none";
  el.innerHTML = msg || "";
  el.style.borderLeft = isErr ? "3px solid var(--danger)" : "3px solid var(--primary)";
  el.style.color = isErr ? "var(--danger)" : "";
}

function onWalletConnected(addr) {
  userAddress = addr;
  const tag = window.jumpWallet ? "📧 " : "🦊 ";
  $("myAddr").textContent = tag + addr.slice(0,6) + "…" + addr.slice(-4);
  $("btnConnect").textContent = "연결됨";
  $("btnConnect").disabled    = true;
  loadFromFirestore();
}

// ── Load ──────────────────────────────────────────────────────────────────────
async function loadFromFirestore() {
  if (!userAddress) return;
  try {
    const snap = await getDoc(doc(db, "users", userAddress.toLowerCase()));
    if (!snap.exists()) { showNote("저장된 프로필이 없습니다. 입력 후 저장하세요."); return; }
    const d = snap.data() || {};
    if ($("kakaoId"))    $("kakaoId").value    = d.kakaoId    || "";
    if ($("telegramId")) $("telegramId").value = d.telegramId || "";
    showNote("프로필 불러오기 완료");
  } catch (e) {
    showNote("불러오기 실패: " + e.message, true);
  }
}

// ── Save ──────────────────────────────────────────────────────────────────────
async function saveToFirestore() {
  if (!userAddress) { showNote("지갑을 먼저 연결하세요.", true); return; }

  const kakaoId    = ($("kakaoId")?.value    || "").trim();
  const telegramId = ($("telegramId")?.value || "").trim();

  if (!kakaoId && !telegramId) {
    showNote("카카오톡 또는 텔레그램 중 1개 이상 입력하세요.", true); return;
  }

  try {
    await setDoc(
      doc(db, "users", userAddress.toLowerCase()),
      { wallet: userAddress.toLowerCase(), kakaoId, telegramId, updatedAt: serverTimestamp() },
      { merge: true }
    );
    showNote("저장 완료");
  } catch (e) {
    showNote("저장 실패: " + e.message, true);
  }
}

// ── Bindings ──────────────────────────────────────────────────────────────────
$("btnLoad")?.addEventListener("click", loadFromFirestore);
$("btnSave")?.addEventListener("click", saveToFirestore);

// ── 통합 지갑 자동 연결 ──────────────────────────────────────────────────────
function _tryConnect(addr) {
  if (!addr || userAddress) return;
  onWalletConnected(addr);
}
// 헤더 지갑이 이미 복원된 경우
_tryConnect(window.__hdrWallet?.address || window.jumpWallet?.address);
// 비동기 복원 이벤트 (MetaMask / Jump 모두 수신)
window.addEventListener('wallet:connected', e => _tryConnect(e.detail?.address));
window.addEventListener('jump:connected',   e => _tryConnect(e.detail?.address));
// 페이지 버튼 → 헤더 지갑에 위임
$("btnConnect")?.addEventListener("click", () => window.__hdrWallet?.connect());
