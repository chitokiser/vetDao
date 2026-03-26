// /assets/js/pages/payment-methods.js
import {
  collection, query, where, getDocs,
  addDoc, updateDoc, deleteDoc, doc, serverTimestamp
} from "https://www.gstatic.com/firebasejs/10.7.0/firebase-firestore.js";

await window.firebaseReady;

const db = window.db;
const PM_COL = "payment_methods";

let walletAddr = null;

// ── DOM refs ──────────────────────────────────────────────────────────────────
const elAddr       = document.getElementById("walletAddr");
const elNote       = document.getElementById("note");
const elPmList     = document.getElementById("pmList");
const elPmForm     = document.getElementById("pmForm");
const elFormTitle  = document.getElementById("formTitle");
const elEditingId  = document.getElementById("editingId");

const elPmType          = document.getElementById("pmType");
const elPmBankName      = document.getElementById("pmBankName");
const elPmAccountName   = document.getElementById("pmAccountName");
const elPmAccountNumber = document.getElementById("pmAccountNumber");
const elPmNote          = document.getElementById("pmNote");

const elBankNameWrap      = document.getElementById("bankNameWrap");
const elAccountNameWrap   = document.getElementById("accountNameWrap");
const elAccountNumberWrap = document.getElementById("accountNumberWrap");

// ── Type metadata ─────────────────────────────────────────────────────────────
const TYPE_LABEL = {
  BANK_KR: "🏦 한국 계좌이체 (KRW)",
  BANK_VN: "🏦 베트남 계좌이체 (VND)",
  CASH:    "💵 현금 직거래",
  QR:      "📱 QR 결제",
};

function isBankType(t) { return t === "BANK_KR" || t === "BANK_VN"; }

// ── Helpers ───────────────────────────────────────────────────────────────────
function showNote(msg, isErr = false) {
  elNote.textContent = msg;
  elNote.style.display = "block";
  elNote.style.borderLeft = isErr ? "3px solid var(--danger)" : "3px solid var(--primary)";
  elNote.style.color = isErr ? "var(--danger)" : "";
}
function hideNote() { elNote.style.display = "none"; }

// ── Form field visibility ─────────────────────────────────────────────────────
function updateFieldVisibility() {
  const t = elPmType.value;
  const isBank = isBankType(t);
  elBankNameWrap.style.display      = isBank ? "" : "none";
  elAccountNameWrap.style.display   = isBank ? "" : "none";
  elAccountNumberWrap.style.display = (isBank || t === "QR") ? "" : "none";
}
elPmType.addEventListener("change", updateFieldVisibility);

// ── Load & render list ────────────────────────────────────────────────────────
async function loadMethods(addr) {
  elPmList.innerHTML = `<div class="muted" style="font-size:13px;text-align:center;padding:28px 0;">불러오는 중…</div>`;
  try {
    const q = query(collection(db, PM_COL), where("user", "==", addr.toLowerCase()));
    const snap = await getDocs(q);
    const methods = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    renderMethods(methods);
  } catch (e) {
    console.error(e);
    showNote("결제수단 로드 실패: " + e.message, true);
    elPmList.innerHTML = `<div class="muted" style="font-size:13px;text-align:center;padding:28px 0;">로드 실패</div>`;
  }
}

function renderMethods(methods) {
  if (!methods.length) {
    elPmList.innerHTML = `<div class="muted" style="font-size:13px;text-align:center;padding:28px 0;">등록된 결제수단이 없습니다. + 추가를 눌러 등록하세요.</div>`;
    return;
  }
  elPmList.innerHTML = methods.map(pm => {
    const label = TYPE_LABEL[pm.type] ?? pm.type;
    const isBank = isBankType(pm.type);
    const detail = isBank
      ? [pm.bankName, pm.accountName, pm.accountNumber].filter(Boolean).join(" · ")
      : pm.type === "QR"
        ? (pm.accountNumber || "")
        : (pm.note || "");
    return `
      <div class="pm-card" style="display:flex;justify-content:space-between;align-items:flex-start;gap:12px;padding:12px 0;border-bottom:1px solid var(--border);">
        <div style="flex:1;min-width:0;">
          <div style="font-weight:600;font-size:14px;margin-bottom:4px;">${label}</div>
          ${detail ? `<div class="mono muted" style="font-size:13px;word-break:break-all;">${detail}</div>` : ""}
          ${pm.note && isBank ? `<div class="muted" style="font-size:12px;margin-top:4px;">${pm.note}</div>` : ""}
        </div>
        <div style="display:flex;gap:8px;flex-shrink:0;">
          <button class="btn secondary" style="padding:4px 12px;font-size:13px;" onclick="editPm('${pm.id}')">수정</button>
          <button class="btn danger"    style="padding:4px 12px;font-size:13px;" onclick="deletePm('${pm.id}')">삭제</button>
        </div>
      </div>`;
  }).join("");
}

// ── Show/hide form ────────────────────────────────────────────────────────────
function showForm(pm = null) {
  hideNote();
  if (pm) {
    elFormTitle.textContent = "결제수단 수정";
    elEditingId.value       = pm.id;
    elPmType.value          = pm.type ?? "BANK_KR";
    elPmBankName.value      = pm.bankName ?? "";
    elPmAccountName.value   = pm.accountName ?? "";
    elPmAccountNumber.value = pm.accountNumber ?? "";
    elPmNote.value          = pm.note ?? "";
  } else {
    elFormTitle.textContent = "결제수단 추가";
    elEditingId.value       = "";
    elPmType.value          = "BANK_KR";
    elPmBankName.value      = "";
    elPmAccountName.value   = "";
    elPmAccountNumber.value = "";
    elPmNote.value          = "";
  }
  updateFieldVisibility();
  elPmForm.style.display = "";
  elPmForm.scrollIntoView({ behavior: "smooth", block: "nearest" });
}

function hideForm() {
  elPmForm.style.display = "none";
  elEditingId.value = "";
}

// ── Save ──────────────────────────────────────────────────────────────────────
async function savePm() {
  if (!walletAddr) { showNote("먼저 지갑을 연결하세요.", true); return; }

  const type          = elPmType.value;
  const bankName      = elPmBankName.value.trim();
  const accountName   = elPmAccountName.value.trim();
  const accountNumber = elPmAccountNumber.value.trim();
  const note          = elPmNote.value.trim();

  if (isBankType(type) && !bankName) {
    showNote("은행명을 입력하세요.", true); return;
  }

  const data = {
    user: walletAddr.toLowerCase(),
    type,
    bankName:      bankName      || null,
    accountName:   accountName   || null,
    accountNumber: accountNumber || null,
    note:          note          || null,
    updatedAt: serverTimestamp(),
  };

  try {
    const editId = elEditingId.value;
    if (editId) {
      await updateDoc(doc(db, PM_COL, editId), data);
      showNote("결제수단이 수정되었습니다.");
    } else {
      data.createdAt = serverTimestamp();
      await addDoc(collection(db, PM_COL), data);
      showNote("결제수단이 등록되었습니다.");
    }
    hideForm();
    await loadMethods(walletAddr);
  } catch (e) {
    console.error(e);
    showNote("저장 실패: " + e.message, true);
  }
}

// ── Edit (called from rendered HTML) ─────────────────────────────────────────
window.editPm = async function(id) {
  try {
    const q = query(collection(db, PM_COL), where("user", "==", walletAddr.toLowerCase()));
    const snap = await getDocs(q);
    const found = snap.docs.find(d => d.id === id);
    if (!found) { showNote("수정할 항목을 찾지 못했습니다.", true); return; }
    showForm({ id: found.id, ...found.data() });
  } catch (e) {
    showNote("오류: " + e.message, true);
  }
};

// ── Delete (called from rendered HTML) ───────────────────────────────────────
window.deletePm = async function(id) {
  if (!confirm("이 결제수단을 삭제하시겠습니까?")) return;
  try {
    await deleteDoc(doc(db, PM_COL, id));
    showNote("삭제되었습니다.");
    await loadMethods(walletAddr);
  } catch (e) {
    showNote("삭제 실패: " + e.message, true);
  }
};

// ── Wallet connected handler (공통) ──────────────────────────────────────────
function onWalletConnected(addr) {
  walletAddr = addr;
  const tag = window.jumpWallet ? "📧 " : "🦊 ";
  elAddr.textContent = tag + addr.slice(0, 6) + "…" + addr.slice(-4);
  const btn = document.getElementById("btnConnect");
  btn.textContent = "연결됨";
  btn.disabled = true;
  hideNote();
  loadMethods(walletAddr);
}

// ── Wallet connection ─────────────────────────────────────────────────────────
async function connectWallet() {
  try {
    // Case 1: Jump 수탁지갑이 이미 헤더에서 로그인됨
    if (window.jumpWallet?.address) {
      onWalletConnected(window.jumpWallet.address);
      return;
    }
    // Case 2: MetaMask/Rabby
    if (!window.ethereum) {
      throw new Error("구글 로그인(헤더) 또는 MetaMask 설치가 필요합니다.");
    }
    if (window.__hdrWallet?.connect) await window.__hdrWallet.connect();
    const provider = new ethers.BrowserProvider(window.ethereum);
    await provider.send("eth_requestAccounts", []);
    const signer = await provider.getSigner();
    onWalletConnected(await signer.getAddress());
  } catch (e) {
    showNote("지갑 연결 실패: " + e.message, true);
  }
}

// ── Button bindings ───────────────────────────────────────────────────────────
document.getElementById("btnConnect").addEventListener("click", connectWallet);
document.getElementById("btnAdd").addEventListener("click", () => {
  if (!walletAddr) { showNote("먼저 지갑을 연결하세요.", true); return; }
  showForm();
});
document.getElementById("btnCancelForm").addEventListener("click", () => { hideForm(); hideNote(); });
document.getElementById("btnSavePm").addEventListener("click", savePm);

// ── Jump wallet: 헤더에서 Google 로그인 완료 시 자동 연결 ─────────────────────
window.addEventListener("jump:connected", (e) => {
  if (!walletAddr && e.detail?.address) {
    onWalletConnected(e.detail.address);
  }
});

// ── Auto-connect if already connected ────────────────────────────────────────
// Jump 수탁지갑 우선 확인
if (window.jumpWallet?.address) {
  onWalletConnected(window.jumpWallet.address);
} else if (window.ethereum) {
  try {
    const accounts = await window.ethereum.request({ method: "eth_accounts" });
    if (accounts.length) onWalletConnected(accounts[0]);
  } catch (_) {}
}
