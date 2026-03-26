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

// ── Wallet connect ────────────────────────────────────────────────────────────
async function connectWallet() {
  try {
    if (window.jumpWallet?.address) { onWalletConnected(window.jumpWallet.address); return; }
    if (!window.ethereum) throw new Error("구글 로그인(헤더) 또는 MetaMask 설치가 필요합니다.");
    if (window.__hdrWallet?.connect) await window.__hdrWallet.connect();
    const provider = new window.ethers.BrowserProvider(window.ethereum);
    await provider.send("eth_requestAccounts", []);
    const signer = await provider.getSigner();
    onWalletConnected(await signer.getAddress());
  } catch (e) {
    showNote("지갑 연결 실패: " + e.message, true);
  }
}

// ── Bindings ──────────────────────────────────────────────────────────────────
$("btnConnect")?.addEventListener("click", connectWallet);
$("btnLoad")?.addEventListener("click",    loadFromFirestore);
$("btnSave")?.addEventListener("click",    saveToFirestore);

// Jump: 헤더에서 Google 로그인 완료 시
window.addEventListener("jump:connected", (e) => {
  if (!userAddress && e.detail?.address) onWalletConnected(e.detail.address);
});

// Auto-connect
if (window.jumpWallet?.address) {
  onWalletConnected(window.jumpWallet.address);
} else if (window.ethereum) {
  try {
    const accs = await window.ethereum.request({ method: "eth_accounts" });
    if (accs.length) onWalletConnected(accs[0]);
  } catch (_) {}
}
