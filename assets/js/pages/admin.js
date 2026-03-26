// /assets/js/pages/admin.js
const CONFIG = window.CONFIG;
const ABI    = window.ABI;
const ethers = window.ethers;

const $ = (id) => document.getElementById(id);

const ADMIN_EMAIL = "daguru75@gmail.com";

let provider, signer, account;

// ── 관리자 접근 제어 ──────────────────────────────────────────────────────────
function checkAdmin() {
  const email = window.jumpWallet?.email || null;
  const ok    = email === ADMIN_EMAIL;
  $("adminDenied").style.display  = ok ? "none" : "";
  $("adminContent").style.display = ok ? ""     : "none";
  if (ok) initAdmin();
  return ok;
}

// Jump 로그인 완료 이벤트 수신
window.addEventListener("jump:connected", (e) => {
  checkAdmin();
});

// ── 관리자 초기화 ─────────────────────────────────────────────────────────────
async function initAdmin() {
  // Jump 수탁지갑으로 로그인된 경우 주소 표시
  if (window.jumpWallet?.address) {
    account = window.jumpWallet.address;
    const el = $("myAddr");
    if (el) el.textContent = account.slice(0,6) + "…" + account.slice(-4);
  }
  // MetaMask가 연결되어 있으면 자동으로 사용
  if (!account && window.ethereum) {
    try {
      const accs = await window.ethereum.request({ method: "eth_accounts" });
      if (accs.length) {
        provider = new ethers.BrowserProvider(window.ethereum);
        signer   = await provider.getSigner();
        account  = await signer.getAddress();
        const el = $("myAddr");
        if (el) el.textContent = account.slice(0,6) + "…" + account.slice(-4);
      }
    } catch (_) {}
  }
  refresh().catch(() => {});
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function setNote(msg, isErr = false) {
  const el = $("note");
  if (!el) return;
  el.style.display = msg ? "block" : "none";
  el.textContent   = msg || "";
  el.style.borderLeft = isErr ? "3px solid var(--danger)" : "3px solid var(--primary)";
  el.style.color = isErr ? "var(--danger)" : "";
}

async function ensureSigner() {
  if (signer) return signer;
  if (window.ethereum) {
    provider = new ethers.BrowserProvider(window.ethereum);
    await provider.send("eth_requestAccounts", []);
    signer  = await provider.getSigner();
    account = await signer.getAddress();
    return signer;
  }
  throw new Error("MetaMask 연결 또는 수탁지갑이 필요합니다.");
}

async function getContract() {
  if (!CONFIG?.CONTRACT?.vetEX) throw new Error("CONFIG.CONTRACT.vetEX 없음");
  if (!ABI?.length)             throw new Error("window.ABI 없음");
  const s = await ensureSigner();
  return new ethers.Contract(CONFIG.CONTRACT.vetEX, ABI, s);
}

// ── Refresh ───────────────────────────────────────────────────────────────────
async function refresh() {
  setNote("");
  try {
    const rpc = new ethers.JsonRpcProvider(CONFIG.RPC_URL);
    const c   = new ethers.Contract(CONFIG.CONTRACT.vetEX, ABI, rpc);
    const pending = await c.pendingHexFee();
    const el = $("pendingRaw");
    if (el) el.textContent = pending.toString();
    if (!$("toAddr").value && account) $("toAddr").value = account;
  } catch (e) {
    setNote("조회 실패: " + (e?.message || String(e)), true);
  }
}

// ── Withdraw ──────────────────────────────────────────────────────────────────
async function withdrawAll() {
  setNote("");
  try {
    const to = ($("toAddr")?.value || "").trim();
    if (!ethers.isAddress(to)) { setNote("출금 주소가 올바르지 않습니다.", true); return; }

    const c       = await getContract();
    const pending = await c.pendingHexFee();
    if (pending === 0n) { setNote("pendingHexFee가 0 입니다.", true); return; }

    setNote("트랜잭션 전송 중…");
    const tx = await c.withdrawHexFee(to, pending);
    setNote("전송됨: " + tx.hash);
    await tx.wait();
    await refresh();
    setNote("전액 이체 완료 ✔");
  } catch (e) {
    setNote(e?.shortMessage || e?.message || String(e), true);
  }
}

// ── Button bindings ───────────────────────────────────────────────────────────
$("btnRefresh")?.addEventListener("click",     () => refresh());
$("btnWithdrawAll")?.addEventListener("click", () => withdrawAll());

// ── Boot ──────────────────────────────────────────────────────────────────────
checkAdmin();
