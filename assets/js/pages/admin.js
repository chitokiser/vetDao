// /assets/js/pages/admin.js
await window.firebaseReady;

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
window.addEventListener("jump:connected", () => {
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

function setNote2(id, msg, isErr = false) {
  const el = $(id);
  if (!el) return;
  el.style.display = msg ? "block" : "none";
  el.textContent   = msg || "";
  el.style.borderLeft = isErr ? "3px solid var(--danger)" : "3px solid var(--primary)";
  el.style.color = isErr ? "var(--danger)" : "";
}

// ── Refresh ───────────────────────────────────────────────────────────────────
async function refresh() {
  setNote("");
  try {
    const rpc = new ethers.JsonRpcProvider(CONFIG.RPC_URL);
    const c   = new ethers.Contract(CONFIG.CONTRACT.vetEX, ABI, rpc);

    const [pending, total, hexBank, feeBps] = await Promise.all([
      c.pendingHexFee(),
      c.totalHexFeeCollected(),
      c.hexBank(),
      c.feeBps(),
    ]);

    if ($("pendingRaw"))  $("pendingRaw").textContent  = pending.toString();
    if ($("totalFeeVal")) $("totalFeeVal").textContent = total.toString();
    if ($("feeBpsVal"))   $("feeBpsVal").textContent   = feeBps.toString() + " (" + (Number(feeBps) / 100).toFixed(2) + "%)";
    if ($("hexBankVal"))  $("hexBankVal").textContent  = hexBank || "(미설정)";

    const isUnset = !hexBank || hexBank === "0x0000000000000000000000000000000000000000";
    if ($("hexBankWarn")) $("hexBankWarn").style.display = isUnset ? "block" : "none";

    if (!$("toAddr").value && account) $("toAddr").value = account;
    if (!$("newHexBank").value && account) $("newHexBank").value = account;
  } catch (e) {
    setNote("조회 실패: " + (e?.message || String(e)), true);
  }
}

// ── Set hexBank ───────────────────────────────────────────────────────────────
async function doSetHexBank() {
  setNote2("noteHexBank", "");
  const addr = ($("newHexBank")?.value || "").trim();
  if (!ethers.isAddress(addr)) { setNote2("noteHexBank", "유효한 주소를 입력하세요.", true); return; }
  try {
    const c  = await getContract();
    setNote2("noteHexBank", "트랜잭션 전송 중…");
    const tx = await c.setHexBank(addr);
    setNote2("noteHexBank", "전송됨: " + tx.hash);
    await tx.wait();
    await refresh();
    setNote2("noteHexBank", "hexBank 설정 완료 ✔ → " + addr);
  } catch (e) {
    setNote2("noteHexBank", e?.shortMessage || e?.message || String(e), true);
  }
}

// ── Withdraw (flushFeeNow) ─────────────────────────────────────────────────────
async function withdrawAll() {
  setNote("");
  try {
    const to = ($("toAddr")?.value || "").trim();
    if (!ethers.isAddress(to)) { setNote("출금 주소가 올바르지 않습니다.", true); return; }

    const rpc     = new ethers.JsonRpcProvider(CONFIG.RPC_URL);
    const cRpc    = new ethers.Contract(CONFIG.CONTRACT.vetEX, ABI, rpc);
    const pending = await cRpc.pendingHexFee();
    if (pending === 0n) { setNote("pendingHexFee가 0 입니다.", true); return; }

    const c = await getContract();
    setNote("트랜잭션 전송 중…");
    const tx = await c.flushFeeNow(to);
    setNote("전송됨: " + tx.hash);
    await tx.wait();
    await refresh();
    setNote("전액 이체 완료 ✔");
  } catch (e) {
    setNote(e?.shortMessage || e?.message || String(e), true);
  }
}

// ── Set feeBps (긴급 수수료 변경) ─────────────────────────────────────────────
async function doSetFeeBps(bps) {
  setNote2("noteFee", "");
  try {
    const c  = await getContract();
    setNote2("noteFee", `feeBps = ${bps} 전송 중…`);
    const tx = await c.setFeeBps(bps);
    setNote2("noteFee", "전송됨: " + tx.hash);
    await tx.wait();
    await refresh();
    setNote2("noteFee", `수수료 ${bps === 0 ? "0% (긴급 설정)" : (bps / 100).toFixed(2) + "%"} 완료 ✔`);
  } catch (e) {
    setNote2("noteFee", e?.shortMessage || e?.message || String(e), true);
  }
}

// ── On-chain → Firestore 동기화 ──────────────────────────────────────────────
async function syncTrades() {
  const from = parseInt($("syncFrom")?.value || "1");
  const to   = parseInt($("syncTo")?.value   || "10");
  if (isNaN(from) || isNaN(to) || from < 1 || to < from) {
    setNote2("noteSync", "tradeId 범위가 올바르지 않습니다.", true);
    return;
  }

  setNote2("noteSync", `tradeId ${from}~${to} 조회 중…`);

  const rpc = new ethers.JsonRpcProvider(CONFIG.RPC_URL);
  const c   = new ethers.Contract(CONFIG.CONTRACT.vetEX, ABI, rpc);
  const db  = window.db;

  const { doc: fsDoc, getDoc: fsGetDoc, setDoc: fsSetDoc, serverTimestamp } =
    await import("https://www.gstatic.com/firebasejs/10.7.0/firebase-firestore.js");

  const fiatLabel = { 0: "KRW", 1: "VND" };
  const statusLabel = ["OPEN","TAKEN","PAID","RELEASED","CANCELED","DISPUTED","RESOLVED"];

  let created = 0, skipped = 0, log = "";

  for (let id = from; id <= to; id++) {
    try {
      const on = await c.getTrade(id);
      const seller = on.seller?.toLowerCase();
      if (!seller || seller === "0x0000000000000000000000000000000000000000") {
        log += `#${id}: 거래 없음\n`;
        continue;
      }

      const chainStatus = Number(on.status ?? on[10] ?? 0);
      const fiat        = fiatLabel[Number(on.fiat ?? on[9] ?? 0)] ?? "KRW";
      const amount      = Number(ethers.formatUnits(on.amount, 18));
      const fiatAmount  = Number(on.fiatAmount ?? 0);

      // Firestore 문서 존재 여부 확인
      const ref  = fsDoc(db, "ads", String(id));
      const snap = await fsGetDoc(ref);

      if (snap.exists()) {
        log += `#${id}: 이미 존재 (status=${snap.data()?.status})\n`;
        skipped++;
        continue;
      }

      // OPEN(0) 상태인 경우에만 복구
      if (chainStatus !== 0) {
        log += `#${id}: on-chain status=${statusLabel[chainStatus]||chainStatus} → 복구 생략\n`;
        skipped++;
        continue;
      }

      // Firestore에 기본 광고 문서 생성
      await fsSetDoc(ref, {
        type:           "SELL",
        tradeId:        id,
        seller,
        tokenSymbol:    "HEX",
        amount,
        originalAmount: amount,
        unitPrice:      fiatAmount > 0 ? Math.round(fiatAmount / amount) : 0,
        fiat,
        fiatAmount,
        minFiat:        0,
        maxFiat:        fiatAmount,
        timeoutMin:     30,
        terms:          null,
        paymentMethodIds: [],
        paymentMethods:   [],
        contract:       (CONFIG.CONTRACT.vetEX || "").toLowerCase(),
        txHash:         null,
        blockNumber:    null,
        status:         "OPEN",
        createdAt:      serverTimestamp(),
        updatedAt:      serverTimestamp(),
        _recovered:     true,
      });

      log += `#${id}: ✅ 복구 완료 (${amount} HEX, ${fiat})\n`;
      created++;
    } catch (e) {
      log += `#${id}: 오류 — ${e.message}\n`;
    }
  }

  setNote2("noteSync", `완료 — 복구: ${created}건, 건너뜀: ${skipped}건\n\n${log}`);
}

// ── Button bindings ───────────────────────────────────────────────────────────
$("btnRefresh")?.addEventListener("click",     () => refresh());
$("btnSetHexBank")?.addEventListener("click",  () => doSetHexBank());
$("btnWithdrawAll")?.addEventListener("click", () => withdrawAll());
$("btnSetFee0")?.addEventListener("click",     () => doSetFeeBps(0));
$("btnSetFee50")?.addEventListener("click",    () => doSetFeeBps(50));
$("btnSyncTrades")?.addEventListener("click",  () => syncTrades());

// ── Boot ──────────────────────────────────────────────────────────────────────
checkAdmin();
