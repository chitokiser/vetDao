// /assets/js/pages/sell.js
import {
  doc, getDoc, setDoc, addDoc,
  collection, query, where, getDocs,
  serverTimestamp,
} from "https://www.gstatic.com/firebasejs/10.7.0/firebase-firestore.js";

await window.firebaseReady;

const ethers  = window.ethers;
const CONFIG  = window.CONFIG;
const ABI     = window.ABI;
const db      = window.db;

const $ = (id) => document.getElementById(id);

const ERC20_ABI = [
  "function allowance(address owner,address spender) view returns (uint256)",
  "function approve(address spender,uint256 value) returns (bool)",
];

let provider, signer, account;
let userPaymentMethods = [];
let adType = "SELL"; // "SELL" | "BUY"

// ── Debug log ────────────────────────────────────────────────────────────────
function dbg(msg) {
  const p = $("dbg");
  if (p) p.textContent += msg + "\n";
  console.log("[sell]", msg);
}

// ── Note banner ───────────────────────────────────────────────────────────────
function setNote(msg, isErr = false) {
  const el = $("note");
  if (!el) return;
  el.style.display = msg ? "block" : "none";
  el.innerHTML = msg || "";
  el.style.borderLeft = isErr ? "3px solid var(--danger)" : "3px solid var(--primary)";
  el.style.color = isErr ? "var(--danger)" : "";
  if (msg) el.scrollIntoView({ behavior: "smooth", block: "center" });
}

// ── Fiat enum (matches contract) ──────────────────────────────────────────────
function fiatEnum(fiat) { return fiat === "KRW" ? 0 : 1; }

// ── Total preview ─────────────────────────────────────────────────────────────
function updateTotal() {
  const a = Number($("amount")?.value  || 0);
  const p = Number($("unitPrice")?.value || 0);
  const fiat = $("fiat")?.value || "KRW";
  const out = $("totalFiat");
  if (!out) return;
  out.textContent = (a && p) ? (a * p).toLocaleString() + " " + fiat : "-";
}

// ── Ad type toggle ────────────────────────────────────────────────────────────
function switchAdType(type) {
  adType = type;
  const isSell = type === "SELL";

  $("btnTypeSell")?.classList.toggle("active", isSell);
  $("btnTypeSell")?.classList.toggle("sell",   isSell);
  $("btnTypeBuy")?.classList.toggle("active", !isSell);
  $("btnTypeBuy")?.classList.toggle("buy",    !isSell);

  if ($("sellInfo"))       $("sellInfo").style.display       = isSell ? "block" : "none";
  if ($("buyInfo"))        $("buyInfo").style.display        = isSell ? "none"  : "block";
  if ($("pmSection"))      $("pmSection").style.display      = isSell ? ""      : "none";
  if ($("buyerBankSection")) $("buyerBankSection").style.display = isSell ? "none" : "";

  const lbl = $("labelAmount");
  if (lbl) lbl.textContent = isSell ? "판매 수량 (HEX) *" : "구매 수량 (HEX) *";
}

$("btnTypeSell")?.addEventListener("click", () => switchAdType("SELL"));
$("btnTypeBuy")?.addEventListener("click",  () => switchAdType("BUY"));

// ── Jump custodial helpers ────────────────────────────────────────────────────
function activeAccount() { return window.jumpWallet?.address || account; }

async function jumpSendTx(to, abiFragments, fnName, args) {
  const idToken = await window.jumpWallet.getIdToken();
  // BigInt → string 변환 (JSON 직렬화)
  const callArgs = (args || []).map(a => typeof a === "bigint" ? a.toString() : a);
  // abi는 human-readable 문자열 배열 그대로 전달
  const abi = Array.isArray(abiFragments) ? abiFragments : [abiFragments];
  let result;
  try {
    result = await window.jumpSignTx(idToken, {
      type:   "contract",
      to,
      abi,
      method: fnName,
      args:   callArgs,
    });
  } catch (e) {
    const msg = e?.message || String(e);
    if (msg.includes("수탁 지갑이 없습니다") || msg.includes("404")) {
      throw new Error(
        "수탁 지갑이 없습니다. Jump 마이페이지에서 지갑을 먼저 생성해 주세요.\n👉 jump22.netlify.app/mypage"
      );
    }
    throw e;
  }
  const txHash  = result?.data?.txHash || result?.txHash;
  if (!txHash) throw new Error("Jump: txHash 없음 — 응답: " + JSON.stringify(result));
  const rpc     = new ethers.JsonRpcProvider(CONFIG.RPC_URL);
  const receipt = await rpc.waitForTransaction(txHash, 1, 90000);
  if (receipt?.status === 0) throw new Error("트랜잭션 실패 (status=0)");
  return receipt;
}

// ── Wallet connect (onSubmit에서 미연결 시 호출) ─────────────────────────────
async function connectWallet() {
  if (account) return; // 이미 연결됨
  await window.__hdrWallet?.connect(); // 헤더 지갑에 위임 (팝업 처리)
  // 연결 완료 후 wallet:connected 이벤트가 onAccountConnected를 호출함
  // 그래도 account가 없으면 즉시 시도
  const addr = window.__hdrWallet?.address || window.jumpWallet?.address;
  if (addr && !account) await onAccountConnected(addr);
}

// ── Load payment methods → render checkboxes ──────────────────────────────────
const TYPE_LABEL = {
  BANK_KR: "🏦 한국 계좌이체 (KRW)",
  BANK_VN: "🏦 베트남 계좌이체 (VND)",
  CASH:    "💵 현금 직거래",
  QR:      "📱 QR 결제",
};

async function loadPaymentMethods(addr) {
  const wrap = $("pmCheckboxes");
  if (!wrap) return;
  try {
    const q    = query(collection(db, "payment_methods"), where("user", "==", addr.toLowerCase()));
    const snap = await getDocs(q);
    userPaymentMethods = snap.docs.map(d => ({ id: d.id, ...d.data() }));

    if (!userPaymentMethods.length) {
      wrap.innerHTML = `<div class="muted" style="font-size:13px;">
        등록된 결제수단이 없습니다.
        <a href="/payment-methods.html" style="color:var(--primary); margin-left:6px;">결제수단 등록하기 →</a>
      </div>`;
      return;
    }

    wrap.innerHTML = userPaymentMethods.map(pm => {
      const label  = TYPE_LABEL[pm.type] ?? pm.type;
      const detail = [pm.bankName, pm.accountName, pm.accountNumber].filter(Boolean).join(" · ");
      return `
        <label style="display:flex; align-items:flex-start; gap:10px; padding:10px; border:1px solid var(--border); border-radius:10px; margin-bottom:8px; cursor:pointer;">
          <input type="checkbox" name="pm" value="${pm.id}" style="margin-top:3px; flex-shrink:0;" />
          <div>
            <div style="font-size:14px; font-weight:600;">${label}</div>
            ${detail ? `<div class="mono muted" style="font-size:12px; margin-top:2px;">${detail}</div>` : ""}
            ${pm.note ? `<div class="muted" style="font-size:12px;">${pm.note}</div>` : ""}
          </div>
        </label>`;
    }).join("");
  } catch (e) {
    wrap.innerHTML = `<div class="muted" style="font-size:13px;">결제수단 로드 실패: ${e.message}</div>`;
  }
}

// ── Seller profile check ──────────────────────────────────────────────────────
async function checkSellerProfile(addr) {
  const ref  = doc(db, "users", addr.toLowerCase());
  const snap = await getDoc(ref);
  if (!snap.exists()) return false;
  const d = snap.data() || {};
  return !!(String(d.kakaoId || "").trim() || String(d.telegramId || "").trim());
}

// ── ERC20 allowance ───────────────────────────────────────────────────────────
async function ensureAllowance(tokenAddr, amountWei) {
  if (window.jumpWallet) {
    const rpc   = new ethers.JsonRpcProvider(CONFIG.RPC_URL);
    const token = new ethers.Contract(tokenAddr, ERC20_ABI, rpc);
    const cur   = await token.allowance(window.jumpWallet.address, CONFIG.CONTRACT.vetEX);
    if (cur >= amountWei) return;
    setNote("토큰 승인(approve) 진행 중 (Jump)…");
    await jumpSendTx(tokenAddr, ERC20_ABI, "approve", [CONFIG.CONTRACT.vetEX, amountWei]);
    return;
  }
  const token = new ethers.Contract(tokenAddr, ERC20_ABI, signer);
  const cur   = await token.allowance(account, CONFIG.CONTRACT.vetEX);
  if (cur >= amountWei) return;
  setNote("토큰 승인(approve) 진행 중…");
  const tx = await token.approve(CONFIG.CONTRACT.vetEX, amountWei);
  await tx.wait();
}

// ── Parse tradeId from TradeOpened event ─────────────────────────────────────
function parseTradeId(receipt) {
  const iface = new ethers.Interface(ABI);
  for (const log of receipt.logs || []) {
    if (!log.address) continue;
    if (log.address.toLowerCase() !== CONFIG.CONTRACT.vetEX.toLowerCase()) continue;
    try {
      const parsed = iface.parseLog(log);
      if (parsed?.name === "TradeOpened") return Number(parsed.args.tradeId);
    } catch {}
  }
  return null;
}

// ── SELL flow ─────────────────────────────────────────────────────────────────
async function submitSell(addr, fiat, amount, unitPrice, fiatAmt, minFiat, maxFiat, terms, timeoutMin) {
  // Payment methods
  const checked = [...document.querySelectorAll('input[name="pm"]:checked')].map(el => el.value);
  if (!checked.length) return setNote("결제수단을 최소 1개 선택하세요.", true);

  const selectedPms = userPaymentMethods.filter(pm => checked.includes(pm.id));

  const tokenCfg = CONFIG?.TOKENS?.HEX;
  if (!tokenCfg?.address) return setNote("config.js TOKENS.HEX 없음", true);

  const amountWei = ethers.parseUnits(String(amount), tokenCfg.decimals ?? 18);

  // 1. Approve
  await ensureAllowance(tokenCfg.address, amountWei);

  // 2. openTrade
  let receipt;
  if (window.jumpWallet) {
    setNote("트랜잭션 전송 중 (Jump)…");
    receipt = await jumpSendTx(
      CONFIG.CONTRACT.vetEX, ABI, "openTrade",
      [amountWei, ethers.ZeroAddress, fiatEnum(fiat), fiatAmt, ethers.ZeroHash]
    );
  } else {
    const c = new ethers.Contract(CONFIG.CONTRACT.vetEX, ABI, signer);
    setNote("트랜잭션 전송 중…");
    const tx = await c.openTrade(
      amountWei, ethers.ZeroAddress, fiatEnum(fiat), fiatAmt, ethers.ZeroHash
    );
    receipt = await tx.wait();
  }

  const tradeId = parseTradeId(receipt);
  if (!tradeId) return setNote("등록됐으나 tradeId를 못 찾았습니다. ABI 확인 필요", true);
  dbg("tradeId=" + tradeId);

  // 3. Firestore ads/{tradeId}
  setNote("파이어베이스 저장 중…");
  await setDoc(doc(db, "ads", String(tradeId)), {
    type:          "SELL",
    tradeId,
    seller:        addr.toLowerCase(),
    tokenSymbol:   "HEX",
    amount,
    originalAmount: amount,   // 최초 등록 수량 (부분 체결 후에도 원본 보존)
    unitPrice,
    fiat,
    fiatAmount:    fiatAmt,
    minFiat:       minFiat || 0,
    maxFiat:       maxFiat || fiatAmt,
    timeoutMin:    timeoutMin || 30,
    terms:         terms || null,
    paymentMethodIds: checked,
    paymentMethods:   selectedPms.map(pm => ({
      id: pm.id, type: pm.type,
      bankName: pm.bankName || null,
      accountName: pm.accountName || null,
      accountNumber: pm.accountNumber || null,
      note: pm.note || null,
    })),
    contract:    (CONFIG.CONTRACT.vetEX || "").toLowerCase(),
    txHash:      receipt.hash,
    blockNumber: receipt.blockNumber,
    status:      "OPEN",
    createdAt:   serverTimestamp(),
    updatedAt:   serverTimestamp(),
  });

  setNote(`✔ 판매 광고 등록 완료 (tradeId: ${tradeId}) — <a href="/trade.html?id=${tradeId}" style="color:var(--primary);">거래 페이지 보기 →</a>`);
  dbg("done: tradeId=" + tradeId);
}

// ── BUY flow ──────────────────────────────────────────────────────────────────
async function submitBuy(addr, fiat, amount, unitPrice, fiatAmt, minFiat, maxFiat, terms, timeoutMin) {
  const bankName    = $("buyerBank")?.value?.trim()        || null;
  const accountName = $("buyerAccountName")?.value?.trim() || null;
  const accountNum  = $("buyerAccount")?.value?.trim()     || null;

  // 저장 (on-chain 없음 — 판매자가 acceptOffer 시 openTrade 호출)
  setNote("구매 광고 저장 중…");
  const ref = await addDoc(collection(db, "ads"), {
    type:           "BUY",
    buyer:          addr.toLowerCase(),
    tokenSymbol:    "HEX",
    amount,
    originalAmount: amount,   // 최초 등록 수량
    unitPrice,
    fiat,
    fiatAmount:  fiatAmt,
    minFiat:     minFiat || 0,
    maxFiat:     maxFiat || fiatAmt,
    timeoutMin:  timeoutMin || 30,
    terms:       terms || null,
    buyerBank: bankName ? {
      bankName,
      accountName,
      accountNumber: accountNum,
    } : null,
    status:    "OPEN",
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
  });

  setNote(`✔ 구매 광고 등록 완료 — <a href="/trade.html?adId=${ref.id}&type=BUY" style="color:var(--primary);">광고 보기 →</a>`);
  dbg("BUY ad id=" + ref.id);
}

// ── Submit dispatcher ─────────────────────────────────────────────────────────
async function onSubmit() {
  setNote("");
  try {
    if (!window.jumpWallet && !account) await connectWallet();
    const addr = activeAccount();
    if (!addr) return setNote("지갑을 연결하세요.", true);

    // Profile check
    const hasProfile = await checkSellerProfile(addr);
    if (!hasProfile) {
      setNote(
        `광고 등록 전에 프로필에서 SNS(카카오/텔레그램) 최소 1개 등록이 필요합니다.
         <a class="btn" href="/profile.html" style="margin-left:8px; padding:4px 10px; font-size:12px;">프로필로 가기</a>`,
        true
      );
      return;
    }

    // Common input validation
    const fiat     = $("fiat")?.value?.trim() || "KRW";
    const amtStr   = $("amount")?.value?.trim() || "";
    const priceStr = $("unitPrice")?.value?.trim() || "";
    const minStr   = $("minFiat")?.value?.trim()  || "";
    const maxStr   = $("maxFiat")?.value?.trim()  || "";
    const terms    = $("terms")?.value?.trim()    || "";
    const timeoutMin = Number($("timeoutMin")?.value || 30);

    if (!amtStr   || Number(amtStr)   <= 0) return setNote("수량을 입력하세요.", true);
    if (!priceStr || Number(priceStr) <= 0) return setNote("개당 가격을 입력하세요.", true);

    const amount    = Number(amtStr);
    const unitPrice = Number(priceStr);
    const minFiat   = minStr ? Number(minStr) : 0;
    const maxFiat   = maxStr ? Number(maxStr) : Math.floor(amount * unitPrice);
    const fiatAmt   = Math.floor(amount * unitPrice);

    if (minFiat > fiatAmt) return setNote("최소 거래금액이 총액보다 클 수 없습니다.", true);
    if (maxFiat < minFiat) return setNote("최대 거래금액이 최소보다 작을 수 없습니다.", true);

    if (adType === "SELL") {
      await submitSell(addr, fiat, amount, unitPrice, fiatAmt, minFiat, maxFiat, terms, timeoutMin);
    } else {
      await submitBuy(addr, fiat, amount, unitPrice, fiatAmt, minFiat, maxFiat, terms, timeoutMin);
    }
  } catch (e) {
    console.error(e);
    const msg = e?.shortMessage || e?.info?.error?.message || e?.reason || e?.message || String(e);
    setNote(msg, true);
  }
}

// ── Bindings ──────────────────────────────────────────────────────────────────
$("btnConnect")?.addEventListener("click", async () => {
  try { await connectWallet(); }
  catch (e) { setNote(e.message || String(e), true); }
});

$("btnSubmit")?.addEventListener("click", async () => {
  const btn = $("btnSubmit");
  const orig = btn?.textContent;
  if (btn) { btn.disabled = true; btn.textContent = "처리 중…"; }
  try { await onSubmit(); }
  finally { if (btn) { btn.disabled = false; btn.textContent = orig; } }
});

$("amount")?.addEventListener("input",    updateTotal);
$("unitPrice")?.addEventListener("input", updateTotal);
$("fiat")?.addEventListener("change",     updateTotal);

updateTotal();

// ── 통합 지갑 자동 연결 (헤더 지갑과 공유) ──────────────────────────────────
async function onAccountConnected(addr) {
  if (!addr || account) return;
  const isJump = !!window.jumpWallet;
  account = addr;
  if (isJump) {
    provider = null; signer = null;
  } else if (window.ethereum) {
    try {
      provider = new ethers.BrowserProvider(window.ethereum);
      signer   = await provider.getSigner();
    } catch (_) {}
  }
  const tag = isJump ? "📧 " : "🦊 ";
  $("walletAddr").textContent = tag + account.slice(0,6) + "…" + account.slice(-4);
  $("btnConnect").textContent = "연결됨";
  $("btnConnect").disabled    = true;
  await loadPaymentMethods(account);
}

// 헤더 지갑이 이미 복원된 경우
const _initAddr = window.__hdrWallet?.address || window.jumpWallet?.address;
if (_initAddr) {
  onAccountConnected(_initAddr);
}
// 비동기 복원 이벤트 (MetaMask / Jump 모두 수신)
window.addEventListener('wallet:connected', e => onAccountConnected(e.detail?.address));
window.addEventListener('jump:connected',   e => onAccountConnected(e.detail?.address));
// 페이지 버튼 → 헤더 지갑에 위임
$("btnConnect")?.addEventListener("click", () => window.__hdrWallet?.connect());

dbg("sell.js ready");

// ── 재등록: URL 파라미터로 폼 미리 채우기 ────────────────────────────────────
// 예: /sell.html?preset=1&type=BUY&fiat=VND&amount=100&unitPrice=27300&...
(function prefillFromUrl() {
  const p = new URLSearchParams(location.search);
  if (!p.get("preset")) return;

  const type = p.get("type") || "SELL";
  switchAdType(type); // 광고 유형 전환 (버튼 UI 포함)

  const fiatEl = $("fiat");
  if (fiatEl && p.get("fiat") != null) {
    fiatEl.value = p.get("fiat");
  }
  const setVal = (id, key) => {
    const el = $(id);
    if (el && p.get(key)) el.value = p.get(key);
  };
  setVal("amount",    "amount");
  setVal("unitPrice", "unitPrice");
  setVal("minFiat",   "minFiat");
  setVal("maxFiat",   "maxFiat");
  setVal("terms",     "terms");

  const toEl = $("timeoutMin");
  if (toEl && p.get("timeoutMin")) {
    // select에서 가장 가까운 option 선택
    const target = p.get("timeoutMin");
    const opt = [...toEl.options].find(o => o.value === target);
    if (opt) toEl.value = target;
  }

  updateTotal();

  // 안내 배너 표시
  const note = $("note");
  if (note) {
    note.style.display = "block";
    note.style.borderLeft = "3px solid var(--primary)";
    note.style.color = "";
    note.innerHTML = "✅ 이전 거래와 같은 조건으로 미리 채워졌습니다. 수량을 확인 후 등록하세요.";
  }
})();
