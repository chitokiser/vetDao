// /assets/js/pages/trade.js
import {
  doc, getDoc, setDoc, addDoc, updateDoc,
  collection, query, orderBy, where, getDocs, onSnapshot,
  serverTimestamp, increment,
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
  "function balanceOf(address) view returns (uint256)",
  "function decimals() view returns (uint8)",
];

let provider, signer, account;
let adData   = null;  // Firestore ad doc
let orderId  = null;  // Firestore orders doc ID
let chainData = null; // on-chain getTrade result
let unsubMessages = null;

// ── URL params ────────────────────────────────────────────────────────────────
const params  = new URLSearchParams(location.search);
const tradeIdParam = params.get("id");   // SELL: on-chain tradeId
const adIdParam    = params.get("adId"); // BUY: Firestore doc ID
const typeParam    = params.get("type"); // "BUY" if BUY ad

// ── Helpers ───────────────────────────────────────────────────────────────────
function dbg(msg) {
  const p = $("dbg");
  if (p) p.textContent += msg + "\n";
  console.log("[trade]", msg);
}
function setNote(msg, isErr = false) {
  const el = $("note");
  if (!el) return;
  el.style.display = msg ? "block" : "none";
  el.innerHTML = msg || "";
  el.style.borderLeft = isErr ? "3px solid var(--danger)" : "3px solid var(--primary)";
  el.style.color = isErr ? "var(--danger)" : "";
}
// 부분 체결 후 계속/종료 모달
// filledHex: 이번 거래에서 체결된 수량, remainingHex: 남은 수량, isBuyAd: BUY 광고 여부
function showPartialModal(filledHex, remainingHex, isBuyAd, onContinue, onClose) {
  const modal = $("partialModal");
  if (!modal) { onClose?.(); return; }

  const fiatLabel_ = fiatLabel(adData?.fiat);
  const price      = Number(adData?.unitPrice || 0);
  const remainFiat = price > 0 ? (remainingHex * price).toLocaleString() + " " + fiatLabel_ : "";

  $("partialModalTitle").textContent    = "거래 완료! 🎉";
  $("partialModalFilled").textContent   = `이번 체결: ${fmtNum(filledHex)} HEX`;
  $("partialModalRemaining").textContent = fmtNum(remainingHex) + " HEX" + (remainFiat ? " ≈ " + remainFiat : "");
  $("partialModalQuestion").textContent = isBuyAd
    ? "아직 구매 목표 수량이 남았습니다. 광고를 유지하고 계속 구매하시겠습니까?"
    : "에스크로된 HEX 중 잔여분이 지갑으로 반환됩니다. 나머지 수량으로 판매를 계속하시겠습니까?";

  modal.style.display = "flex";

  const btnContinue = $("partialModalContinue");
  const btnClose    = $("partialModalClose");

  const cleanup = () => { modal.style.display = "none"; };
  const handleContinue = () => { cleanup(); btnContinue.removeEventListener("click", handleContinue); btnClose.removeEventListener("click", handleClose_); onContinue?.(); };
  const handleClose_   = () => { cleanup(); btnContinue.removeEventListener("click", handleContinue); btnClose.removeEventListener("click", handleClose_); onClose?.(); };

  btnContinue.addEventListener("click", handleContinue);
  btnClose.addEventListener("click",    handleClose_);
}

// 재등록 URL 생성 (같은 광고 조건으로 sell.html 프리필)
function buildReregisterUrl(ad) {
  if (!ad) return "/sell.html";
  const p = new URLSearchParams();
  p.set("preset", "1");
  p.set("type",       ad.type || "SELL");
  p.set("fiat",       ad.fiat ?? "KRW");
  p.set("unitPrice",  ad.unitPrice ?? "");
  // 수량은 원본(originalAmount) 기준으로 재등록
  p.set("amount",     ad.originalAmount || ad.amount || "");
  if (ad.minFiat)    p.set("minFiat",    ad.minFiat);
  if (ad.maxFiat)    p.set("maxFiat",    ad.maxFiat);
  if (ad.terms)      p.set("terms",      ad.terms);
  if (ad.timeoutMin) p.set("timeoutMin", ad.timeoutMin);
  return "/sell.html?" + p.toString();
}

function showCancelModal(title, desc, onConfirm) {
  const modal = $("cancelModal");
  if (!modal) { if (onConfirm) onConfirm(); return; }
  $("cancelModalTitle").textContent = title || "취소 완료";
  $("cancelModalDesc").innerHTML    = desc  || "";
  modal.style.display = "flex";
  const btn = $("cancelModalBtn");
  const handler = () => {
    modal.style.display = "none";
    btn.removeEventListener("click", handler);
    if (onConfirm) onConfirm();
  };
  btn.addEventListener("click", handler);
}
function fmtNum(n) { const v = Number(n); return Number.isFinite(v) ? v.toLocaleString() : "-"; }
function shortAddr(a) { return a ? a.slice(0,6) + "…" + a.slice(-4) : "-"; }
function fiatLabel(v) {
  if (v === 0 || v === "0" || v === "KRW") return "KRW";
  if (v === 1 || v === "1" || v === "VND") return "VND";
  return String(v ?? "-");
}
function statusLabel(n) {
  return ["OPEN","TAKEN","PAID","RELEASED","CANCELED","DISPUTED","RESOLVED"][Number(n)] ?? String(n);
}
function activeAccount() { return window.jumpWallet?.address || account; }

// ── Jump helper ───────────────────────────────────────────────────────────────
async function jumpSendTx(to, abiFragments, fnName, args) {
  const idToken  = await window.jumpWallet.getIdToken();
  const callArgs = (args || []).map(a => typeof a === "bigint" ? a.toString() : a);
  const abi      = Array.isArray(abiFragments) ? abiFragments : [abiFragments];
  const result   = await window.jumpSignTx(idToken, {
    type:   "contract",
    to,
    abi,
    method: fnName,
    args:   callArgs,
  });
  const txHash  = result?.data?.txHash || result?.txHash;
  if (!txHash) throw new Error("Jump: txHash 없음 — 응답: " + JSON.stringify(result));
  const rpc     = new ethers.JsonRpcProvider(CONFIG.RPC_URL);
  const receipt = await rpc.waitForTransaction(txHash, 1, 90000);
  if (receipt?.status === 0) throw new Error("트랜잭션 실패 (status=0)");
  return receipt;
}

// ── Wallet connect ────────────────────────────────────────────────────────────
async function connectWallet() {
  if (window.jumpWallet?.address) {
    account = window.jumpWallet.address;
    $("walletAddr").textContent = "📧 " + account.slice(0,6) + "…" + account.slice(-4);
    $("btnConnect").textContent = "연결됨";
    $("btnConnect").disabled    = true;
    return account;
  }
  if (!window.ethereum) throw new Error("MetaMask 또는 구글 로그인이 필요합니다.");
  if (window.__hdrWallet?.connect) await window.__hdrWallet.connect();
  provider = new ethers.BrowserProvider(window.ethereum);
  await provider.send("eth_requestAccounts", []);
  signer  = await provider.getSigner();
  account = await signer.getAddress();
  $("walletAddr").textContent = "🦊 " + account.slice(0,6) + "…" + account.slice(-4);
  $("btnConnect").textContent = "연결됨";
  $("btnConnect").disabled    = true;
  return account;
}

// ── Progress bar ──────────────────────────────────────────────────────────────
// chainStatus: 0=OPEN,1=TAKEN,2=PAID,3=RELEASED,4=CANCELED
// For BUY ad before on-chain: chainStatus = -1 (just OPEN in Firestore)
function updateProgress(chainStatus) {
  const st = Number(chainStatus ?? -1);
  // step1=에스크로, step2=입금대기, step3=입금확인, step4=완료
  const states = {
    "-1": [false,false,false,false], // BUY ad not yet on-chain
    "0":  [true, false,false,false], // OPEN - escrow done
    "1":  [true, true, false,false], // TAKEN - waiting payment
    "2":  [true, true, true, false], // PAID - waiting release
    "3":  [true, true, true, true],  // RELEASED/COMPLETED
    "4":  [false,false,false,false], // CANCELED
  };
  const active = {
    "-1": 1, "0": 2, "1": 2, "2": 3, "3": 4, "4": 0,
  };
  const done = states[String(st)] ?? states["0"];
  const activeStep = active[String(st)] ?? 0;

  for (let i = 1; i <= 4; i++) {
    const el = $("step" + i);
    if (!el) continue;
    el.classList.toggle("done",   done[i-1]);
    el.classList.toggle("active", !done[i-1] && activeStep === i);
  }
}

// ── Timer ─────────────────────────────────────────────────────────────────────
let timerInterval = null;

function startTimer(escrowedAtMs, timeoutMin, onExpire) {
  const timerEl   = $("tradeTimer");
  const displayEl = $("timerDisplay");
  const noteEl    = $("timerNote");
  if (!timerEl || !displayEl) return;

  if (timerInterval) clearInterval(timerInterval);

  const deadlineMs = escrowedAtMs + timeoutMin * 60 * 1000;
  let expired = false;

  function tick() {
    const now  = Date.now();
    const left = deadlineMs - now;
    if (left <= 0) {
      displayEl.textContent = "00:00";
      timerEl.classList.add("expired");
      if (noteEl) noteEl.textContent = "타임아웃 — 판매자·구매자 모두 취소 가능";
      clearInterval(timerInterval);
      if (!expired) { expired = true; if (onExpire) onExpire(); }
      return;
    }
    const m = Math.floor(left / 60000);
    const s = Math.floor((left % 60000) / 1000);
    displayEl.textContent = String(m).padStart(2,"0") + ":" + String(s).padStart(2,"0");
    timerEl.classList.remove("expired");
    if (noteEl) noteEl.textContent = "입금 후 '입금 완료' 버튼을 눌러주세요";
  }
  timerEl.classList.add("visible");
  tick();
  timerInterval = setInterval(tick, 1000);
}

function stopTimer() {
  if (timerInterval) { clearInterval(timerInterval); timerInterval = null; }
  const timerEl = $("tradeTimer");
  if (timerEl) timerEl.classList.remove("visible");
}

// ── Render trade info ─────────────────────────────────────────────────────────
function renderInfo(ad, chainSt, tradeId) {
  const fiat       = fiatLabel(ad.fiat);
  const amount     = fmtNum(ad.amount);
  const unitPrice  = fmtNum(ad.unitPrice);
  const total      = fmtNum(ad.fiatAmount || (ad.amount * ad.unitPrice));
  const timeout    = (ad.timeoutMin || CONFIG.PAYMENT_TIMEOUT_MIN || 30) + "분";

  const statusN  = Number(chainSt ?? (ad.type === "BUY" ? -1 : 0));
  const statusStr = statusN < 0 ? "OPEN" : statusLabel(statusN);
  const sbClass   = { OPEN:"sb-open", TAKEN:"sb-taken", PAID:"sb-paid",
                      RELEASED:"sb-released", CANCELED:"sb-canceled", DISPUTED:"sb-disputed" }[statusStr] ?? "sb-open";

  const vStatus = $("vStatus");
  if (vStatus) vStatus.innerHTML = `<span class="status-badge ${sbClass}">${statusStr}</span>`;

  if ($("vTradeId"))   $("vTradeId").textContent   = tradeId ?? "-";
  if ($("vAmount"))    $("vAmount").textContent     = amount + " HEX";
  if ($("vUnitPrice")) $("vUnitPrice").textContent  = unitPrice + " " + fiat;
  if ($("vTotal"))     $("vTotal").textContent      = total + " " + fiat;
  if ($("vFiat"))      $("vFiat").textContent       = fiat;
  if ($("vTimeout"))   $("vTimeout").textContent    = timeout;
  if ($("vSeller"))    $("vSeller").textContent     = ad.seller ? shortAddr(ad.seller) : "-";
  if ($("vBuyer"))     $("vBuyer").textContent      = ad.buyer  ? shortAddr(ad.buyer)  : "-";

  // 구매 수량 / 입금 총액 (거래 신청 후)
  if (ad.buyAmount) {
    const rowAmt  = $("rowBuyAmount");
    const rowFiat = $("rowBuyFiat");
    if (rowAmt)  { rowAmt.style.display  = "";  $("vBuyAmount").textContent = fmtNum(ad.buyAmount) + " HEX"; }
    if (rowFiat) { rowFiat.style.display = "";  $("vBuyFiat").textContent   = fmtNum(ad.buyFiat) + " " + fiat; }
  }

  const termsEl = $("vTerms");
  if (termsEl && ad.terms) {
    termsEl.style.display = "block";
    termsEl.textContent = "📋 " + ad.terms;
  }

  // Ad type badge
  const badgeEl = $("adTypeBadge");
  if (badgeEl) {
    if (ad.type === "BUY") {
      badgeEl.innerHTML = `<span style="color:#22c55e;">📥 구매 광고</span> · 구매자가 HEX를 사고 싶어합니다`;
    } else {
      badgeEl.innerHTML = `<span style="color:#f97316;">📤 판매 광고</span> · 판매자가 HEX를 팝니다`;
    }
  }

  // Role badge
  renderRoleBadge(ad, activeAccount());
}

function renderRoleBadge(ad, me) {
  const el = $("myRoleBadge");
  if (!el) return;
  const meL = (me || "").toLowerCase();
  const sellerL = (ad.seller || "").toLowerCase();
  const buyerL  = (ad.buyer  || "").toLowerCase();
  let role = "viewer", label = "관찰자";
  if (meL && meL === sellerL) { role = "seller"; label = "판매자"; }
  else if (meL && buyerL && meL === buyerL) { role = "buyer";  label = "구매자"; }
  else if (meL) { role = "viewer"; label = "참여 가능"; }
  el.className = "role-badge " + role;
  el.textContent = label;
}

// ── Render payment methods ────────────────────────────────────────────────────
const TYPE_LABEL = {
  BANK_KR: "🏦 한국 계좌이체",
  BANK_VN: "🏦 베트남 계좌이체",
  CASH:    "💵 현금",
  QR:      "📱 QR",
};

function renderPaymentMethods(ad) {
  const list = $("pmList");
  if (!list) return;

  // BUY ad: seller's bank account (where buyer sends VND)
  if (ad.type === "BUY" && ad.sellerBank) {
    const sb = ad.sellerBank;
    if (sb.bankName || sb.accountNumber) {
      list.innerHTML = `<div class="pm-card">
        <div class="pm-type">🏦 판매자 계좌 (VND 입금처)</div>
        <div class="pm-detail">
          ${sb.bankName      ? `<div><span style="color:var(--muted);">은행:</span> <strong>${sb.bankName}</strong></div>` : ""}
          ${sb.accountName   ? `<div><span style="color:var(--muted);">예금주:</span> <strong>${sb.accountName}</strong></div>` : ""}
          ${sb.accountNumber ? `<div><span style="color:var(--muted);">계좌:</span> <strong class="mono">${sb.accountNumber}</strong></div>` : ""}
        </div>
      </div>`;
      return;
    }
  }

  const pms = ad.paymentMethods || [];
  if (!pms.length) {
    list.innerHTML = `<div class="muted" style="font-size:13px;">결제수단 정보 없음</div>`;
    return;
  }
  list.innerHTML = pms.map(pm => {
    const type = TYPE_LABEL[pm.type] ?? pm.type;
    const bank = pm.bankName ? `<div><span style="color:var(--muted);">은행:</span> <strong>${pm.bankName}</strong></div>` : "";
    const name = pm.accountName ? `<div><span style="color:var(--muted);">예금주:</span> <strong>${pm.accountName}</strong></div>` : "";
    const num  = pm.accountNumber ? `<div><span style="color:var(--muted);">계좌:</span> <strong class="mono">${pm.accountNumber}</strong></div>` : "";
    const note = pm.note ? `<div style="color:var(--muted); font-size:12px; margin-top:4px;">${pm.note}</div>` : "";
    return `<div class="pm-card"><div class="pm-type">${type}</div><div class="pm-detail">${bank}${name}${num}${note}</div></div>`;
  }).join("");
}

// ── Trade stats helper ────────────────────────────────────────────────────────
async function updateTradeStats(addr, isSuccess) {
  if (!addr) return;
  try {
    const ref = doc(db, "users", addr.toLowerCase());
    const updates = { totalTrades: increment(1) };
    if (isSuccess) updates.completedTrades = increment(1);
    await updateDoc(ref, updates);
  } catch {}
}

// ── Render seller SNS + stats ──────────────────────────────────────────────────
// isBuyAd: BUY 광고일 때 true → 광고등록자 = 구매자 레이블로 표시
async function loadSellerSns(sellerAddr, isBuyAd = false) {
  const el        = $("vSellerSns");
  const labelEl   = $("snsPanelLabel");
  if (!el || !sellerAddr) return;

  // 패널 레이블 동적 변경
  if (labelEl) {
    labelEl.textContent = isBuyAd ? "광고등록자 연락처" : "판매자 연락처";
  }

  try {
    const snap = await getDoc(doc(db, "users", sellerAddr.toLowerCase()));
    if (snap.exists()) {
      const d     = snap.data() || {};
      const kk    = d.kakaoId    ? `<div>💬 카카오: <strong>${d.kakaoId}</strong></div>`    : "";
      const tg    = d.telegramId ? `<div>✈ 텔레그램: <strong>${d.telegramId}</strong></div>` : "";
      const total = d.totalTrades    ?? 0;
      const done  = d.completedTrades ?? 0;
      const rate  = total > 0 ? Math.round((done / total) * 100) : null;
      const stats = `<div style="margin-bottom:6px; font-size:12px; color:#94a3b8;">
        📊 거래건수: <strong style="color:#e2e8f0;">${total}건</strong>
        &nbsp;·&nbsp; 성공률: <strong style="color:#22c55e;">${rate !== null ? rate + "%" : "-"}</strong>
      </div>`;
      el.innerHTML = stats + ((kk + tg) || "<span class='muted'>등록된 연락처 없음</span>");
    } else {
      el.innerHTML = "<span class='muted'>등록된 연락처 없음</span>";
    }
  } catch {}
}

// ── Timeout check ─────────────────────────────────────────────────────────────
// 현재 배포 컨트랙트: timeoutSeconds 필드 없음 → Firestore adData.timeoutMin 기준
function isTimedOut() {
  if (!chainData) return false;
  const takenAt = Number(chainData.takenAt ?? chainData[7] ?? 0);
  if (!takenAt) return false;
  const timeoutSec = (adData?.timeoutMin || CONFIG.PAYMENT_TIMEOUT_MIN || 30) * 60;
  return Math.floor(Date.now() / 1000) >= takenAt + timeoutSec;
}

// ── Action buttons visibility ─────────────────────────────────────────────────
function renderActions(ad, chainSt) {
  const me       = (activeAccount() || "").toLowerCase();
  const sellerL  = (ad.seller || "").toLowerCase();
  const buyerL   = (ad.buyer  || "").toLowerCase();
  const st       = Number(chainSt ?? -1);
  const isSeller = me && me === sellerL;
  const isBuyer  = me && buyerL && me === buyerL;
  const timedOut = isTimedOut();

  // Hide all first
  ["sellerAcceptSection","buyerConfirmSection","acceptSection","paidSection","btnRelease","btnCancel","btnCancelOpen","btnCancelByBuyer","btnDispute","editBuyAdSection","btnCleanupGhost"]
    .forEach(id => { const el = $(id); if (el) el.style.display = "none"; });

  const guide = $("actionGuide");

  // BUY ad — OPEN: buyer can edit/cancel
  if (ad.type === "BUY" && st < 0 && isBuyer) {
    show("editBuyAdSection");
    initEditBuyAdForm(ad);
    setGuide("📢 판매자 모집 중입니다. 환율 변동 시 단가를 수정하거나 광고를 취소할 수 있습니다.", false);
    return;
  }

  // BUY ad — viewer (potential seller) can accept
  if (ad.type === "BUY" && st < 0 && !isBuyer && me) {
    show("sellerAcceptSection");
    initSellerAcceptForm(ad);
    setGuide("💡 보유한 HEX 수량을 입력하고 판매 신청하세요. 입력한 만큼만 에스크로에 잠깁니다.", false);
    return;
  }

  // BUY ad — OPEN: designated buyer confirms (seller already escrowed)
  if (ad.type === "BUY" && st === 0 && isBuyer) {
    show("buyerConfirmSection");

    // 에스크로된 HEX 수량 + 입금 금액 표시
    const escrowedHex = Number(ad.takenAmount || ad.amount || 0);
    const unitPrice   = Number(ad.unitPrice || 0);
    const fiatAmt     = ad.takenFiat || (escrowedHex > 0 && unitPrice > 0 ? Math.floor(escrowedHex * unitPrice) : 0);
    const fiatUnit    = fiatLabel(ad.fiat);
    const hexEl  = $("buyerEscrowHex");
    const fiatEl = $("buyerPayFiat");
    const unitEl = $("buyerPayFiatUnit");
    if (hexEl)  hexEl.textContent  = escrowedHex > 0 ? escrowedHex.toLocaleString() : "-";
    if (fiatEl) fiatEl.textContent = fiatAmt > 0 ? fiatAmt.toLocaleString() : "-";
    if (unitEl) unitEl.textContent = fiatUnit;

    const sb = ad.sellerBank || {};
    const bankHtml = sb.bankName || sb.accountNumber
      ? `<div><span style="color:var(--muted);">은행:</span> <strong>${sb.bankName || "-"}</strong></div>
         <div><span style="color:var(--muted);">예금주:</span> <strong>${sb.accountName || "-"}</strong></div>
         <div><span style="color:var(--muted);">계좌번호:</span> <strong class="mono">${sb.accountNumber || "-"}</strong></div>`
      : `<div style="color:var(--muted);">판매자 계좌 정보 미등록</div>`;
    const el = $("sellerBankDisplay");
    if (el) el.innerHTML = bankHtml;
    setGuide(`✅ 판매자가 ${escrowedHex > 0 ? escrowedHex.toLocaleString() + " HEX를" : "HEX를"} 에스크로했습니다. 아래 계좌로 ${fiatAmt > 0 ? fiatAmt.toLocaleString() + " " + fiatUnit + "을" : "금액을"} 입금 후 거래를 수락하세요.`, false);
    return;
  }

  // SELL ad — OPEN: seller can cancel/reclaim
  if ((ad.type !== "BUY") && st === 0 && isSeller) {
    // Ghost trade: Firestore에는 있지만 on-chain에 없는 경우 (openTrade 미실행)
    const onChainSeller = (chainData?.seller ?? chainData?.[0] ?? "").toLowerCase();
    const isGhost = !onChainSeller || onChainSeller === "0x0000000000000000000000000000000000000000";
    if (isGhost) {
      show("btnCleanupGhost");
      setGuide("⚠ 이 광고는 블록체인에 등록되지 않았습니다. HEX는 잠기지 않았으니 아래 버튼으로 광고를 삭제하세요.", true);
    } else {
      show("btnCancelOpen");
      setGuide("📢 모집 중입니다. 광고를 취소하면 에스크로된 HEX가 반환됩니다.", false);
    }
    return;
  }

  // SELL ad — OPEN: viewer/buyer can accept
  if ((ad.type !== "BUY") && st === 0 && !isSeller && me) {
    show("acceptSection");
    initAcceptForm(ad);
    setGuide("💡 구매할 수량을 입력하고 거래를 신청하세요.", false);
    return;
  }

  // TAKEN: buyer marks paid / timeout → both can cancel
  if (st === 1) {
    if (timedOut) {
      // 타임아웃 경과 — 판매자·구매자 모두 취소 가능
      if (isSeller) {
        show("btnCancel");
        setGuide("⏰ 타임아웃! 구매자가 입금하지 않았습니다. 거래를 취소할 수 있습니다.", true);
      }
      if (isBuyer) {
        show("btnCancelByBuyer");
        show("paidSection"); // 입금 완료 처리도 여전히 가능
        setGuide("⏰ 타임아웃! 거래를 취소하거나, 입금 완료 처리를 할 수 있습니다.", true);
      }
    } else {
      // 타임아웃 전 — 일반 대기
      if (isBuyer) {
        show("paidSection");
        setGuide("✅ 판매자 계좌로 입금 후 아래 '입금 완료'를 눌러주세요.", false);
      }
      if (isSeller) {
        setGuide("⏳ 구매자의 입금을 기다리고 있습니다. 타임아웃 시 취소 가능합니다.", false);
      }
    }
    return;
  }

  // PAID: seller releases
  if (st === 2) {
    if (isSeller) {
      show("btnRelease");
      show("btnDispute");
      setGuide("💰 입금 확인 후 '토큰 이체'를 눌러 HEX를 구매자에게 보내세요.", false);
    }
    if (isBuyer) {
      setGuide("⏳ 판매자의 토큰 이체를 기다리고 있습니다.", false);
    }
    return;
  }

  if (st === 3) { setGuide("🎉 거래가 완료되었습니다.", false); return; }
  if (st === 4) { setGuide("❌ 거래가 취소되었습니다.", true);  return; }
  if (st === 5) { setGuide("⚠ 분쟁 접수 완료. 관리자에게 문의하세요.", true); return; }

  if (!me) setGuide("지갑을 연결하면 내 역할에 맞는 버튼이 표시됩니다.", false);
}

function show(id) { const el = $(id); if (el) el.style.display = ""; }
function setGuide(msg, isErr) {
  const el = $("actionGuide");
  if (!el) return;
  el.style.display = msg ? "block" : "none";
  el.textContent   = msg || "";
  el.style.borderLeft = isErr ? "3px solid var(--danger)" : "3px solid var(--primary)";
  el.style.color   = isErr ? "var(--danger)" : "";
}

// ── Seller accept form (BUY ad): 보유 잔액 기준 판매 수량 입력 ─────────────────
async function initSellerAcceptForm(ad) {
  const maxAd   = Number(ad.amount || 0);
  const price   = Number(ad.unitPrice || 0);
  const minFiat = Number(ad.minFiat || 0);
  const maxFiat = Number(ad.maxFiat || ad.fiatAmount || maxAd * price);
  const fiat    = fiatLabel(ad.fiat);
  const minHex  = price > 0 ? Math.ceil(minFiat / price) : 0;

  // ── 통화별 필수 안내 배너 ────────────────────────────────────────────────────
  const notice = $("bankRequireNotice");
  if (notice) {
    const fiatStr = (ad.fiat ?? "").toString();
    const isVND = fiatStr === "1" || fiatStr === "VND";
    const isKRW = fiatStr === "0" || fiatStr === "KRW";
    if (isVND) {
      notice.style.display = "block";
      notice.style.background = "rgba(239,68,68,0.08)";
      notice.style.border = "1px solid rgba(239,68,68,0.35)";
      notice.style.color = "#fca5a5";
      notice.innerHTML = `
        <div style="font-weight:700; font-size:14px; margin-bottom:4px;">🇻🇳 베트남 VND 결제 광고입니다</div>
        구매자는 <strong>베트남 동(VND)</strong>으로 입금합니다.<br>
        반드시 <strong>베트남 은행 계좌</strong>(예: Vietcombank, Techcombank, MB Bank 등)를 입력하세요.<br>
        <span style="color:#ef4444; font-weight:600;">잘못된 계좌(한국 계좌 등) 입력 시 분쟁의 원인이 됩니다.</span>`;
    } else if (isKRW) {
      notice.style.display = "block";
      notice.style.background = "rgba(59,130,246,0.08)";
      notice.style.border = "1px solid rgba(59,130,246,0.3)";
      notice.style.color = "#93c5fd";
      notice.innerHTML = `
        <div style="font-weight:700; font-size:14px; margin-bottom:4px;">🇰🇷 한국 KRW 결제 광고입니다</div>
        구매자는 <strong>원화(KRW)</strong>로 입금합니다.<br>
        반드시 <strong>한국 은행 계좌</strong>를 입력하세요.<br>
        <span style="color:#ef4444; font-weight:600;">잘못된 계좌 입력 시 분쟁의 원인이 됩니다.</span>`;
    } else {
      notice.style.display = "none";
    }
  }

  const inp   = $("inpSellAmount");
  const tot   = $("sellerAcceptTotal");
  const warn  = $("sellerAcceptWarn");
  const btn   = $("btnSellerAccept");
  const hint  = $("sellerAcceptLimitHint");
  const balEl = $("sellerHexBalance");

  // HEX 잔액 조회
  let walletMax = maxAd;
  try {
    const rpc     = new ethers.JsonRpcProvider(CONFIG.RPC_URL);
    const token   = new ethers.Contract(CONFIG.TOKENS.HEX.address, ERC20_ABI, rpc);
    const me      = activeAccount();
    const dec     = CONFIG.TOKENS.HEX.decimals ?? 18;
    const rawBal  = await token.balanceOf(me);
    const hexBal  = Number(ethers.formatUnits(rawBal, dec));
    walletMax     = Math.min(hexBal, maxAd);
    if (balEl) balEl.textContent = hexBal.toLocaleString(undefined, {maximumFractionDigits:4}) + " HEX";
  } catch {
    if (balEl) balEl.textContent = "조회 실패";
  }

  if (hint) hint.textContent = `${minHex.toLocaleString()} ~ ${walletMax.toLocaleString()} HEX 가능`;

  // ── 판매 가능 범위 박스 ────────────────────────────────────────────────────
  const rangeBox = $("sellRangeBox");
  if (rangeBox) {
    const minFiatCalc = minHex > 0 ? Math.floor(minHex * price) : minFiat;
    const maxFiatCalc = Math.floor(walletMax * price);
    const minD = $("sellMinDisplay");
    const minF = $("sellMinFiat");
    const maxD = $("sellMaxDisplay");
    const maxF = $("sellMaxFiat");
    if (minD) minD.textContent = minHex > 0 ? `${minHex.toLocaleString()} HEX` : `제한 없음`;
    if (minF) minF.textContent = minHex > 0 ? `≈ ${minFiatCalc.toLocaleString()} ${fiat}` : "";
    if (maxD) maxD.textContent = `${walletMax.toLocaleString()} HEX`;
    if (maxF) maxF.textContent = `≈ ${maxFiatCalc.toLocaleString()} ${fiat}`;
    rangeBox.style.display = "block";
  }

  $("sellerAcceptMaxBtn")?.addEventListener("click", () => {
    if (inp) { inp.value = walletMax; inp.dispatchEvent(new Event("input")); }
  });

  function recalc() {
    const qty     = Number(inp?.value || 0);
    const fiatAmt = Math.floor(qty * price);
    if (!qty) {
      if (tot)  tot.textContent    = "-";
      if (warn) warn.style.display = "none";
      if (btn)  btn.disabled       = true;
      return;
    }
    if (tot) tot.textContent = fiatAmt.toLocaleString() + " " + fiat;

    let errMsg = "";
    if (qty > walletMax)    errMsg = `잔액 부족 (최대 ${walletMax.toLocaleString()} HEX)`;
    else if (qty > maxAd)   errMsg = `광고 수량 초과 (최대 ${maxAd.toLocaleString()} HEX)`;
    else if (qty < minHex)  errMsg = `최소 ${minHex.toLocaleString()} HEX 이상이어야 합니다.`;
    else if (minFiat && fiatAmt < minFiat) errMsg = `최소 거래금액 ${minFiat.toLocaleString()} ${fiat} 미만입니다.`;
    else if (fiatAmt > maxFiat)            errMsg = `최대 거래금액 ${maxFiat.toLocaleString()} ${fiat} 초과입니다.`;

    if (warn) { warn.textContent = errMsg; warn.style.display = errMsg ? "block" : "none"; }
    if (btn)  btn.disabled = !!errMsg || qty <= 0;
  }

  if (inp) { inp.addEventListener("input", recalc); recalc(); }
  // recalc()가 버튼 활성/비활성을 이미 처리하므로 여기서 추가로 비활성화하지 않음

  // ── 저장된 계좌 불러오기 ────────────────────────────────────────────────────
  loadSavedBanks(ad);
}

// 저장된 결제수단 로드 및 선택 UI 렌더링
async function loadSavedBanks(ad) {
  const list = $("savedBankList");
  if (!list) return;
  const me = activeAccount();
  if (!me) {
    list.innerHTML = `<div style="font-size:12px;color:var(--muted);">지갑 연결 후 저장된 계좌를 불러올 수 있습니다.</div>`;
    showNewBankForm(true);
    return;
  }

  try {
    const fiat = (ad?.fiat || "").toString();
    const pmType = (fiat === "1" || fiat === "VND") ? "BANK_VN" : "BANK_KR";
    const q = query(collection(db, "payment_methods"), where("user", "==", me.toLowerCase()));
    const snap = await getDocs(q);
    const all = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    // fiat 통화에 맞는 계좌 우선, 전체도 표시
    const matched = all.filter(p => p.type === pmType);
    const others  = all.filter(p => p.type !== pmType);
    const sorted  = [...matched, ...others];

    if (!sorted.length) {
      list.innerHTML = `<div style="font-size:12px;color:var(--muted);padding:4px 0;">저장된 계좌 없음 — 아래에서 새로 입력하세요.</div>`;
      showNewBankForm(true);
      // 라디오 "새로 입력" 자동 선택
      const r = $("radioNewBank"); if (r) r.checked = true;
      return;
    }

    // 저장된 계좌 라디오 카드 렌더링
    const fiatStr = (ad?.fiat ?? "").toString();
    const requiredType = (fiatStr === "1" || fiatStr === "VND") ? "BANK_VN"
                       : (fiatStr === "0" || fiatStr === "KRW") ? "BANK_KR" : null;

    list.innerHTML = sorted.map((pm, i) => {
      const typeLabel = pm.type === "BANK_VN" ? "🇻🇳 베트남 계좌" : pm.type === "BANK_KR" ? "🇰🇷 한국 계좌" : pm.type;
      const isMismatch = requiredType && pm.type !== requiredType;
      const mismatchMsg = isMismatch
        ? (requiredType === "BANK_VN"
            ? `<div style="font-size:11px;color:#ef4444;margin-top:3px;">⚠ VND 광고에는 베트남 계좌를 사용하세요</div>`
            : `<div style="font-size:11px;color:#ef4444;margin-top:3px;">⚠ KRW 광고에는 한국 계좌를 사용하세요</div>`)
        : "";
      const borderColor = isMismatch ? "rgba(239,68,68,0.35)" : (i === 0 ? "#f97316" : "var(--line)");
      return `
      <label style="display:flex;align-items:flex-start;gap:8px;cursor:pointer;
                    padding:10px 12px;border-radius:10px;border:1px solid ${borderColor};
                    background:${isMismatch ? "rgba(239,68,68,0.04)" : "rgba(255,255,255,0.04)"};transition:.15s;"
             id="bankCard_${pm.id}">
        <input type="radio" name="bankChoice" value="${pm.id}"
               style="accent-color:#f97316;margin-top:3px;flex-shrink:0;"
               onchange="onBankChoiceChange('${pm.id}')" ${i === 0 && !isMismatch ? "checked" : ""} />
        <div style="flex:1;min-width:0;">
          <div style="font-size:12px;color:var(--muted);margin-bottom:2px;">${typeLabel}</div>
          <div style="font-size:13px;font-weight:600;">${pm.bankName || "-"}</div>
          <div style="font-size:12px;color:var(--muted);">${pm.accountName || ""} · <span class="mono">${pm.accountNumber || ""}</span></div>
          ${mismatchMsg}
        </div>
      </label>`;
    }).join("");

    // 통화 일치하는 첫 번째 계좌 자동 선택
    const firstMatch = sorted.find(p => !requiredType || p.type === requiredType);
    if (firstMatch) {
      const radio = document.querySelector(`input[name="bankChoice"][value="${firstMatch.id}"]`);
      if (radio) radio.checked = true;
      onBankChoiceChange(firstMatch.id, firstMatch);
      const card = $("bankCard_" + firstMatch.id);
      if (card) card.style.borderColor = "#f97316";
    } else {
      // 일치하는 계좌 없음 → 새로 입력 자동 선택
      const r = $("radioNewBank"); if (r) r.checked = true;
      showNewBankForm(true);
    }
    if (firstMatch) showNewBankForm(false);

    // radioNewBank 클릭 시 새 입력 폼 표시
    const radioNew = $("radioNewBank");
    if (radioNew) radioNew.addEventListener("change", () => { showNewBankForm(true); clearBankFields(); });

    // window에 lookup 함수 등록 (inline onchange 용)
    window._savedBankMap = Object.fromEntries(sorted.map(p => [p.id, p]));

  } catch (e) {
    list.innerHTML = `<div style="font-size:12px;color:#ef4444;">계좌 로드 실패: ${e.message}</div>`;
    showNewBankForm(true);
  }
}

function showNewBankForm(show) {
  const f = $("newBankForm");
  if (f) f.style.display = show ? "block" : "none";
}
function clearBankFields() {
  [$("sellerBankName"), $("sellerAccountName"), $("sellerAccountNumber")]
    .forEach(el => { if (el) el.value = ""; });
}
window.onBankChoiceChange = function(pmId, pmObj) {
  // 저장된 계좌 선택 시 hidden 필드에 값 세팅 (doSellerAccept에서 읽음)
  const pm = pmObj || window._savedBankMap?.[pmId];
  if (!pm) return;
  const bn = $("sellerBankName");
  const an = $("sellerAccountName");
  const ac = $("sellerAccountNumber");
  if (bn) bn.value = pm.bankName || "";
  if (an) an.value = pm.accountName || "";
  if (ac) ac.value = pm.accountNumber || "";
  showNewBankForm(false);
  // 테두리 강조 업데이트
  document.querySelectorAll("label[id^='bankCard_']").forEach(el => {
    el.style.borderColor = el.id === "bankCard_" + pmId ? "#f97316" : "var(--line)";
  });
};

// ── Accept form: 수량 입력 + 총액 계산 ────────────────────────────────────────
function initAcceptForm(ad) {
  const maxHex  = Number(ad.amount || 0);
  const price   = Number(ad.unitPrice || 0);
  const minFiat = Number(ad.minFiat || 0);
  const maxFiat = Number(ad.maxFiat || ad.fiatAmount || maxHex * price);
  const fiat    = fiatLabel(ad.fiat);

  // 최소 HEX (minFiat 기준)
  const minHex  = price > 0 ? Math.ceil(minFiat / price) : 0;

  const hint = $("acceptLimitHint");
  if (hint) hint.textContent = `${minHex.toLocaleString()} ~ ${maxHex.toLocaleString()} HEX 가능`;

  const inp  = $("inpBuyAmount");
  const tot  = $("acceptTotal");
  const warn = $("acceptLimitWarn");
  const btn  = $("btnAccept");

  // 최대 수량 버튼
  $("acceptMaxBtn")?.addEventListener("click", () => {
    if (inp) { inp.value = maxHex; inp.dispatchEvent(new Event("input")); }
  });

  function recalc() {
    const qty  = Number(inp?.value || 0);
    const fiatAmt = Math.floor(qty * price);
    if (!qty) {
      if (tot)  tot.textContent  = "-";
      if (warn) warn.style.display = "none";
      if (btn)  btn.disabled = true;
      return;
    }
    if (tot) tot.textContent = fiatAmt.toLocaleString() + " " + fiat;

    // 유효성 검사
    let errMsg = "";
    if (qty > maxHex)      errMsg = `최대 ${maxHex.toLocaleString()} HEX까지 가능합니다.`;
    else if (qty < minHex) errMsg = `최소 ${minHex.toLocaleString()} HEX 이상이어야 합니다.`;
    else if (fiatAmt > maxFiat) errMsg = `최대 거래금액 ${maxFiat.toLocaleString()} ${fiat}을 초과합니다.`;
    else if (fiatAmt < minFiat) errMsg = `최소 거래금액 ${minFiat.toLocaleString()} ${fiat} 미만입니다.`;

    if (warn) {
      warn.textContent   = errMsg;
      warn.style.display = errMsg ? "block" : "none";
    }
    if (btn) btn.disabled = !!errMsg || qty <= 0;
  }

  if (inp) {
    inp.max   = maxHex;
    inp.min   = minHex || 0;
    inp.addEventListener("input", recalc);
    recalc();
  }
  if (btn) btn.disabled = true; // 입력 전 비활성화
}

// ── Chat / messages ───────────────────────────────────────────────────────────
function subscribeMessages(oid, myAddr) {
  if (unsubMessages) { unsubMessages(); unsubMessages = null; }
  if (!oid || !myAddr) return;

  const q = query(
    collection(db, "orders", oid, "messages"),
    orderBy("createdAt", "asc")
  );

  unsubMessages = onSnapshot(q, snap => {
    const container = $("chatMessages");
    if (!container) return;
    container.innerHTML = "";
    if (snap.empty) {
      container.innerHTML = `<div class="muted" style="font-size:13px; text-align:center; padding:20px;">메시지 없음</div>`;
      return;
    }
    snap.forEach(d => {
      const msg  = d.data();
      const isMine = (msg.sender || "").toLowerCase() === (myAddr || "").toLowerCase();
      const div  = document.createElement("div");
      div.className = "chat-msg " + (isMine ? "mine" : "theirs");
      const time = msg.createdAt?.toDate ? msg.createdAt.toDate().toLocaleTimeString("ko-KR", {hour:"2-digit",minute:"2-digit"}) : "";
      div.innerHTML = `<div>${escHtml(msg.text || "")}</div><div class="msg-meta">${shortAddr(msg.sender)} · ${time}</div>`;
      container.appendChild(div);
    });
    container.scrollTop = container.scrollHeight;
  });
}

function escHtml(s) {
  return String(s).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;");
}

async function sendMessage(oid) {
  const input = $("chatInput");
  const text  = input?.value?.trim();
  if (!text || !oid) return;
  const me = activeAccount();
  if (!me) return setNote("메시지를 보내려면 지갑을 연결하세요.", true);
  try {
    await addDoc(collection(db, "orders", oid, "messages"), {
      sender: me.toLowerCase(),
      text,
      createdAt: serverTimestamp(),
    });
    input.value = "";
  } catch (e) {
    setNote("메시지 전송 실패: " + e.message, true);
  }
}

// ── ERC20 approve helper ──────────────────────────────────────────────────────
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

// ── Parse tradeId from receipt ────────────────────────────────────────────────
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

function fiatEnum(fiat) { return fiat === "KRW" ? 0 : 1; }

// ── Load trade ────────────────────────────────────────────────────────────────
async function loadTrade() {
  setNote("");
  try {
    if (tradeIdParam) {
      await loadSellTrade(tradeIdParam);
    } else if (adIdParam) {
      await loadBuyAd(adIdParam);
    } else {
      setNote("URL에 ?id=... 또는 ?adId=... 가 필요합니다.", true);
    }
  } catch (e) {
    console.error(e);
    setNote(e?.message || String(e), true);
  }
}

// SELL ad: load from ads/{tradeId} + on-chain getTrade
async function loadSellTrade(tradeId) {
  // Firestore
  const snap = await getDoc(doc(db, "ads", String(tradeId)));
  if (!snap.exists()) {
    // BUY 광고에서 파생된 거래는 ads/{adId}에 저장되므로 orders에서 adId 조회
    const orderSnap = await getDoc(doc(db, "orders", String(tradeId)));
    if (orderSnap.exists() && orderSnap.data().adId) {
      const buyAdSnap = await getDoc(doc(db, "ads", String(orderSnap.data().adId)));
      adData = buyAdSnap.exists() ? { ...buyAdSnap.data(), docId: buyAdSnap.id } : orderSnap.data();
    } else {
      setNote("광고 정보를 찾을 수 없습니다 (tradeId: " + tradeId + ")", true);
      adData = { type:"SELL", seller:null, amount:0, unitPrice:0, fiat:"KRW" };
    }
  } else {
    adData = snap.data();
  }
  adData.type = adData.type || "SELL";

  // On-chain
  const rpc = new ethers.JsonRpcProvider(CONFIG.RPC_URL);
  const c   = new ethers.Contract(CONFIG.CONTRACT.vetEX, ABI, rpc);
  let on;
  try {
    on = await c.getTrade(Number(tradeId));
    chainData = on;
  } catch (e) {
    dbg("getTrade failed: " + e.message);
    on = null;
  }

  const chainSt = on ? Number(on.status ?? on[11] ?? 0) : 0;

  // Merge on-chain data into adData
  if (on) {
    adData.seller = adData.seller || (on.seller ?? on[0]);
    adData.buyer  = adData.buyer  || (on.buyer  ?? on[1]);
    // Update amount from chain if available
    const tokenCfg = CONFIG.TOKENS?.HEX;
    const dec = tokenCfg?.decimals ?? 18;
    const chainAmount = on.amount ?? on[3];
    if (chainAmount) {
      adData.amount = adData.amount || Number(ethers.formatUnits(chainAmount, dec));
    }
  }

  // orderId = tradeId for SELL
  orderId = String(tradeId);

  renderInfo(adData, chainSt, tradeId);
  renderPaymentMethods(adData);
  renderActions(adData, chainSt);
  updateProgress(chainSt);

  // Timer: start when TAKEN
  if (chainSt === 1) {
    // takenAt: on-chain 기준 우선, 없으면 Firestore escrowedAt
    const takenAtSec = Number(on?.takenAt ?? on?.[7] ?? 0);
    const escAt = takenAtSec > 0 ? takenAtSec * 1000 : (() => {
      // fallback: Firestore
      return Date.now(); // will be replaced asynchronously below
    })();
    const tmin  = adData.timeoutMin || CONFIG.PAYMENT_TIMEOUT_MIN || 30;

    if (takenAtSec > 0) {
      startTimer(escAt, tmin, () => renderActions(adData, chainSt));
    } else {
      const orderSnap = await getDoc(doc(db, "orders", orderId));
      const escAtFs = orderSnap.exists() ? (orderSnap.data().escrowedAt?.toMillis?.() ?? Date.now()) : Date.now();
      startTimer(escAtFs, tmin, () => renderActions(adData, chainSt));
    }
  } else {
    stopTimer();
  }

  // BUY 광고는 광고등록자 = buyer, SELL 광고는 광고등록자 = seller
  const adPosterAddr = adData.type === "BUY" ? adData.buyer : adData.seller;
  await loadSellerSns(adPosterAddr, adData.type === "BUY");
  subscribeMessages(orderId, activeAccount());
  dbg("SELL ad loaded. chainSt=" + chainSt);
}

// BUY ad: load from ads/{adId} (no on-chain yet)
async function loadBuyAd(adId) {
  const snap = await getDoc(doc(db, "ads", adId));
  if (!snap.exists()) {
    setNote("구매 광고를 찾을 수 없습니다.", true);
    return;
  }
  adData = { ...snap.data(), docId: adId };
  adData.type = adData.type || "BUY";

  // If ad has tradeId (seller already responded), load on-chain too
  if (adData.tradeId) {
    orderId = String(adData.tradeId);
    await loadSellTrade(adData.tradeId); // reuse SELL flow
    return;
  }

  // Pure BUY ad (no on-chain yet)
  orderId = adId;
  renderInfo(adData, -1, null);
  renderPaymentMethods(adData);
  renderActions(adData, -1);
  updateProgress(-1);
  stopTimer();

  // Show buyer bank info in pm panel
  if (adData.buyerBank) {
    const list = $("pmList");
    if (list) {
      const b = adData.buyerBank;
      list.innerHTML = `<div class="pm-card">
        <div class="pm-type">🏦 구매자 계좌 (판매자가 입금할 계좌)</div>
        <div class="pm-detail">
          ${b.bankName    ? `<div><span style="color:var(--muted);">은행:</span> <strong>${b.bankName}</strong></div>` : ""}
          ${b.accountName ? `<div><span style="color:var(--muted);">예금주:</span> <strong>${b.accountName}</strong></div>` : ""}
          ${b.accountNumber ? `<div><span style="color:var(--muted);">계좌:</span> <strong class="mono">${b.accountNumber}</strong></div>` : ""}
        </div>
      </div>`;
    }
  }

  await loadSellerSns(adData.buyer, true); // BUY 광고: 광고등록자 = buyer
  subscribeMessages(orderId, activeAccount());
  dbg("BUY ad loaded. docId=" + adId);
}

// ── Actions ───────────────────────────────────────────────────────────────────

// SELL: buyer calls acceptTrade
async function doAccept() {
  setNote("");
  if (!activeAccount()) await connectWallet();
  const tradeId = Number(tradeIdParam);

  // 구매 수량 읽기
  const buyQty   = Number($("inpBuyAmount")?.value || 0);
  const price    = Number(adData?.unitPrice || 0);
  const fiatAmt  = Math.floor(buyQty * price);
  const fiat     = fiatLabel(adData?.fiat);
  const minFiat  = Number(adData?.minFiat || 0);
  const maxFiat  = Number(adData?.maxFiat || adData?.fiatAmount || 0);

  if (!buyQty || buyQty <= 0) return setNote("구매 수량을 입력하세요.", true);
  if (buyQty > Number(adData?.amount || 0)) return setNote("광고 수량을 초과합니다.", true);
  if (minFiat && fiatAmt < minFiat) return setNote(`최소 거래금액 ${minFiat.toLocaleString()} ${fiat} 미만입니다.`, true);
  if (maxFiat && fiatAmt > maxFiat) return setNote(`최대 거래금액 ${maxFiat.toLocaleString()} ${fiat}을 초과합니다.`, true);

  // buyQty(정수 HEX) → wei 변환
  const dec        = CONFIG.TOKENS?.HEX?.decimals ?? 18;
  const buyAmtWei  = ethers.parseUnits(String(buyQty), dec);

  try {
    if (window.jumpWallet) {
      setNote("거래 신청(acceptTrade) 전송 중 (Jump)…");
      await jumpSendTx(CONFIG.CONTRACT.vetEX, ABI, "acceptTrade", [tradeId, buyAmtWei.toString()]);
    } else {
      const c  = new ethers.Contract(CONFIG.CONTRACT.vetEX, ABI, signer);
      setNote("거래 신청(acceptTrade) 전송 중…");
      const tx = await c.acceptTrade(tradeId, buyAmtWei);
      await tx.wait();
    }
    const me = activeAccount();
    // Create order doc (구매 수량 + 입금 총액 기록)
    await setDoc(doc(db, "orders", String(tradeId)), {
      tradeId,
      adId:       String(tradeId),
      type:       "SELL",
      seller:     adData.seller,
      buyer:      me.toLowerCase(),
      buyAmount:  buyQty,      // 구매자가 요청한 HEX 수량
      buyFiat:    fiatAmt,     // 입금 총액
      fiat:       adData.fiat,
      status:     "TAKEN",
      escrowedAt: serverTimestamp(),
      createdAt:  serverTimestamp(),
      updatedAt:  serverTimestamp(),
    });
    // Update ad
    await updateDoc(doc(db, "ads", String(tradeId)), {
      buyer:     me.toLowerCase(),
      buyAmount: buyQty,
      buyFiat:   fiatAmt,
      status:    "TAKEN",
      updatedAt: serverTimestamp(),
    });
    setNote(`거래 신청 완료! 입금 총액: ${fiatAmt.toLocaleString()} ${fiat}`);
    await loadTrade();
  } catch (e) {
    console.error(e);
    setNote(e?.shortMessage || e?.message || String(e), true);
  }
}

// BUY ad: seller calls openTrade to respond
async function doSellerAccept() {
  setNote("");
  if (!activeAccount()) await connectWallet();
  const me = activeAccount();
  try {
    const tokenCfg = CONFIG.TOKENS?.HEX;
    if (!tokenCfg?.address) throw new Error("CONFIG.TOKENS.HEX 없음");

    // 판매자가 입력한 수량 사용 (없으면 광고 전체 수량)
    const inputQty = Number($("inpSellAmount")?.value || 0);
    const amount   = inputQty > 0 ? inputQty : adData.amount;
    const fiatAmt  = Math.floor(amount * adData.unitPrice);
    const amountWei = ethers.parseUnits(String(amount), tokenCfg.decimals ?? 18);
    const buyerAddr = adData.buyer;

    if (!buyerAddr) throw new Error("구매자 주소 없음");

    // 1. Approve
    await ensureAllowance(tokenCfg.address, amountWei);

    // 2. openTrade with buyer address
    let receipt;
    if (window.jumpWallet) {
      setNote("openTrade 전송 중 (Jump)…");
      receipt = await jumpSendTx(
        CONFIG.CONTRACT.vetEX, ABI, "openTrade",
        [amountWei, buyerAddr, fiatEnum(adData.fiat || "KRW"), fiatAmt, ethers.ZeroHash]
      );
    } else {
      const c  = new ethers.Contract(CONFIG.CONTRACT.vetEX, ABI, signer);
      setNote("openTrade 전송 중…");
      const tx = await c.openTrade(
        amountWei, buyerAddr, fiatEnum(adData.fiat || "KRW"), fiatAmt, ethers.ZeroHash
      );
      receipt = await tx.wait();
    }

    const newTradeId = parseTradeId(receipt);
    if (!newTradeId) throw new Error("tradeId를 못 찾았습니다. ABI 확인 필요");
    dbg("BUY→tradeId=" + newTradeId);

    // Seller bank info (where buyer sends VND)
    const sellerBank = {
      bankName:      ($("sellerBankName")?.value || "").trim(),
      accountName:   ($("sellerAccountName")?.value || "").trim(),
      accountNumber: ($("sellerAccountNumber")?.value || "").trim(),
    };
    if (!sellerBank.accountNumber)
      throw new Error("입금받을 계좌번호를 입력해 주세요.");
    if (!sellerBank.bankName)
      throw new Error("은행명을 입력해 주세요.");
    if (!sellerBank.accountName)
      throw new Error("예금주 이름을 입력해 주세요.");

    // 통화와 계좌 국가 일치 검증
    const fiatStr_ = (adData?.fiat ?? "").toString();
    const isVND_   = fiatStr_ === "1" || fiatStr_ === "VND";
    const isKRW_   = fiatStr_ === "0" || fiatStr_ === "KRW";

    const selectedRadio = document.querySelector("input[name='bankChoice']:checked");
    const selectedPmId  = selectedRadio?.value;
    const selectedPm    = window._savedBankMap?.[selectedPmId];

    if (isVND_ && selectedPm && selectedPm.type === "BANK_KR") {
      throw new Error("❌ 이 광고는 베트남 VND 결제입니다.\n한국 계좌는 사용할 수 없습니다.\n베트남 은행 계좌를 선택하거나 입력해 주세요.");
    }
    if (isKRW_ && selectedPm && selectedPm.type === "BANK_VN") {
      throw new Error("❌ 이 광고는 한국 KRW 결제입니다.\n베트남 계좌는 사용할 수 없습니다.\n한국 은행 계좌를 선택하거나 입력해 주세요.");
    }

    // 새로 입력한 경우 저장 여부 확인
    const isNewBank  = $("radioNewBank")?.checked;
    const shouldSave = isNewBank && $("saveNewBank")?.checked;
    if (shouldSave && sellerBank.accountNumber) {
      const fiat_ = adData?.fiat?.toString();
      const pmType = (fiat_ === "1" || fiat_ === "VND") ? "BANK_VN" : "BANK_KR";
      await addDoc(collection(db, "payment_methods"), {
        user:          me.toLowerCase(),
        type:          pmType,
        bankName:      sellerBank.bankName,
        accountName:   sellerBank.accountName,
        accountNumber: sellerBank.accountNumber,
        createdAt:     serverTimestamp(),
      }).catch(() => {}); // 저장 실패해도 거래는 진행
    }

    // 3. Update ad doc: tradeId + seller + sellerBank + takenAmount/takenFiat
    // BUY 광고는 status를 OPEN으로 유지 — 부분 체결 후에도 목록에 계속 표시됨
    // (tradeId 필드로 진행 중 여부 판단, 완전 체결 시에만 COMPLETED로 변경)
    await updateDoc(doc(db, "ads", adIdParam), {
      tradeId:     newTradeId,
      seller:      me.toLowerCase(),
      sellerBank,
      takenAmount: amount,
      takenFiat:   fiatAmt,
      updatedAt:   serverTimestamp(),
    });

    // 4. Create order doc
    await setDoc(doc(db, "orders", String(newTradeId)), {
      tradeId:     newTradeId,
      adId:        adIdParam,
      type:        "BUY",
      seller:      me.toLowerCase(),
      buyer:       buyerAddr.toLowerCase(),
      status:      "TAKEN",
      sellerBank,
      takenAmount: amount,
      takenFiat:   fiatAmt,
      escrowedAt:  serverTimestamp(),
      createdAt:   serverTimestamp(),
      updatedAt:   serverTimestamp(),
    });

    setNote("판매 신청 완료! 거래가 시작됩니다.");
    // Redirect to SELL trade page with new tradeId
    location.href = "/trade.html?id=" + newTradeId;
  } catch (e) {
    console.error(e);
    setNote(e?.shortMessage || e?.message || String(e), true);
  }
}

// Buyer: markPaid
async function doPaid() {
  setNote("");
  if (!activeAccount()) await connectWallet();
  const tradeId = Number(tradeIdParam || adData?.tradeId);
  try {
    const raw = ($("inpRef")?.value || "").trim();
    const ref = raw ? ethers.keccak256(ethers.toUtf8Bytes(raw)) : ethers.ZeroHash;

    if (window.jumpWallet) {
      setNote("입금 완료 표시(markPaid) 전송 중 (Jump)…");
      await jumpSendTx(CONFIG.CONTRACT.vetEX, ABI, "markPaid", [tradeId, ref]);
    } else {
      const c  = new ethers.Contract(CONFIG.CONTRACT.vetEX, ABI, signer);
      setNote("입금 완료 표시(markPaid) 전송 중…");
      const tx = await c.markPaid(tradeId, ref);
      await tx.wait();
    }
    // Update order
    if (orderId) {
      await updateDoc(doc(db, "orders", String(orderId)), {
        status: "PAID", paymentRef: raw || null, updatedAt: serverTimestamp(),
      });
    }
    setNote("입금 완료 표시 완료!");
    await loadTrade();
  } catch (e) {
    console.error(e);
    setNote(e?.shortMessage || e?.message || String(e), true);
  }
}

// Seller: release
async function doRelease() {
  setNote("");
  if (!activeAccount()) await connectWallet();
  const tradeId = Number(tradeIdParam || adData?.tradeId);
  try {
    if (window.jumpWallet) {
      setNote("토큰 이체(release) 전송 중 (Jump)…");
      await jumpSendTx(CONFIG.CONTRACT.vetEX, ABI, "release", [tradeId]);
    } else {
      const c   = new ethers.Contract(CONFIG.CONTRACT.vetEX, ABI, signer);
      setNote("토큰 이체(release) 전송 중…");
      const gas = await c.release.estimateGas(tradeId).catch(() => null);
      const ov  = gas ? { gasLimit: (gas * 130n) / 100n } : { gasLimit: 900000n };
      const tx  = await c.release(tradeId, ov);
      await tx.wait();
    }
    // Update order + ad
    const updates = { status: "RELEASED", updatedAt: serverTimestamp() };
    if (orderId) await updateDoc(doc(db, "orders", String(orderId)), updates);
    const adDocId = tradeIdParam || adIdParam;
    if (adDocId) await updateDoc(doc(db, "ads", String(adDocId)), { status: "RELEASED", updatedAt: serverTimestamp() });

    // Update trade stats: both seller and buyer +1 total, +1 completed
    await Promise.allSettled([
      updateTradeStats(adData?.seller, true),
      updateTradeStats(adData?.buyer,  true),
    ]);

    // ── 부분 체결 감지 ──────────────────────────────────────────────────────
    const dec_      = CONFIG.TOKENS?.HEX?.decimals ?? 18;
    const buyRaw    = chainData?.buyAmount ?? chainData?.[3] ?? 0n;
    const filledHex = Number(ethers.formatUnits(BigInt(buyRaw.toString()), dec_));
    const origAmt   = Number(adData?.originalAmount || adData?.amount || 0);
    const remaining = Math.max(0, origAmt - filledHex);
    const isBuyAd   = adData?.type === "BUY";

    if (remaining > 0) {
      // BUY 광고: 구매자(광고등록자)인 경우에만 모달 표시
      // SELL 광고: 판매자에게 모달 표시
      const me = (activeAccount() || "").toLowerCase();
      const ownerL = isBuyAd
        ? (adData?.buyer  || "").toLowerCase()
        : (adData?.seller || "").toLowerCase();
      const isOwner = me && me === ownerL;

      if (isOwner) {
        showPartialModal(filledHex, remaining, isBuyAd,
          // 계속 진행
          async () => {
            const adDocId_ = adData?.docId || (isBuyAd ? adIdParam : tradeIdParam) || adIdParam;
            if (adDocId_) {
              const updatePayload = {
                status:         "OPEN",
                amount:         remaining,
                originalAmount: origAmt,   // 원래 수량 보존
                updatedAt:      serverTimestamp(),
              };
              if (isBuyAd) {
                // BUY 광고: 다음 판매자를 받을 수 있도록 tradeId/seller 리셋
                updatePayload.tradeId = null;
                updatePayload.seller  = null;
              }
              await updateDoc(doc(db, "ads", String(adDocId_)), updatePayload).catch(() => {});
            }
            setNote(`잔여 ${fmtNum(remaining)} HEX로 광고가 계속 진행됩니다.`);
            location.href = isBuyAd ? `/trade.html?adId=${adData?.docId || adIdParam}&type=BUY` : "/sell.html";
          },
          // 광고 종료
          async () => {
            const adDocId_ = adData?.docId || (isBuyAd ? adIdParam : tradeIdParam) || adIdParam;
            if (adDocId_) await updateDoc(doc(db, "ads", String(adDocId_)), { status: "COMPLETED", updatedAt: serverTimestamp() }).catch(() => {});
            location.href = "/sell.html";
          }
        );
        return; // 모달이 처리하므로 여기서 종료
      }
    }

    // 재등록 URL 빌드 (같은 조건)
    const reUrl = buildReregisterUrl(adData);
    showCancelModal(
      "거래가 완료되었습니다! 🎉",
      `HEX가 구매자에게 이체되었습니다.<br><br>
       <a href="${reUrl}" style="display:inline-block; margin-top:4px; padding:10px 20px; background:var(--primary); color:#fff; border-radius:8px; font-weight:700; text-decoration:none;">
         🔁 같은 조건으로 재등록
       </a>
       <div style="font-size:12px; color:var(--muted); margin-top:8px;">확인을 누르면 내 거래 목록으로 이동합니다.</div>`,
      () => { location.href = "/my-trades.html"; }
    );
  } catch (e) {
    console.error(e);
    // 0x5c975bda = HexBankNotSet() — 컨트랙트에 수수료 수신 주소 미설정
    const errData = e?.data || e?.info?.error?.data || "";
    if (String(errData).includes("5c975bda") || String(e?.message || "").includes("5c975bda")) {
      setNote(
        `⚠️ <strong>컨트랙트 설정 오류: 수수료 수신 주소(hexBank)가 미설정</strong><br>
         관리자가 <a href="/admin.html" style="color:#f97316;font-weight:700;">admin 페이지</a>에서
         hexBank 주소를 설정하거나, 수수료를 <strong>0%로 임시 설정</strong>하면 즉시 처리 가능합니다.`,
        true
      );
    } else {
      setNote(e?.shortMessage || e?.message || String(e), true);
    }
  }
}

// Seller: cancel
async function doCancel() {
  setNote("");
  if (!activeAccount()) await connectWallet();
  const tradeId = Number(tradeIdParam || adData?.tradeId);
  try {
    if (window.jumpWallet) {
      setNote("거래 취소(cancelBySeller) 전송 중 (Jump)…");
      await jumpSendTx(CONFIG.CONTRACT.vetEX, ABI, "cancelBySeller", [tradeId]);
    } else {
      const c  = new ethers.Contract(CONFIG.CONTRACT.vetEX, ABI, signer);
      setNote("거래 취소(cancelBySeller) 전송 중…");
      const tx = await c.cancelBySeller(tradeId);
      await tx.wait();
    }
    const adDocId = tradeIdParam || adIdParam;
    if (adDocId) await updateDoc(doc(db, "ads", String(adDocId)), { status: "CANCELED", updatedAt: serverTimestamp() });
    if (orderId) await updateDoc(doc(db, "orders", String(orderId)), { status: "CANCELED", updatedAt: serverTimestamp() }).catch(()=>{});

    // Update trade stats: seller +1 total only (not completed)
    await updateTradeStats(adData?.seller, false);

    showCancelModal(
      "거래가 취소되었습니다",
      "에스크로된 HEX가 지갑으로 반환되었습니다.",
      () => { location.href = "/sell.html"; }
    );
  } catch (e) {
    console.error(e);
    setNote(e?.shortMessage || e?.message || String(e), true);
  }
}

// Ghost trade: Firestore만 삭제 (on-chain 미등록 광고)
async function doCleanupGhost() {
  if (!confirm("블록체인에 등록되지 않은 광고를 삭제하시겠습니까?\nHEX는 잠기지 않았으므로 안전하게 삭제됩니다.")) return;
  const adDocId = tradeIdParam || adIdParam;
  if (!adDocId) return setNote("광고 ID를 찾을 수 없습니다.", true);
  try {
    await updateDoc(doc(db, "ads", String(adDocId)), {
      status: "CANCELED", cancelReason: "ghost_no_onchain", updatedAt: serverTimestamp(),
    });
    showCancelModal(
      "광고가 삭제되었습니다",
      "블록체인 미등록 광고가 삭제되었습니다.\n광고등록 페이지에서 다시 등록할 수 있습니다.",
      () => { location.href = "/sell.html"; }
    );
  } catch (e) {
    setNote(e?.message || String(e), true);
  }
}

// BUY ad: 수정 폼 초기화
function initEditBuyAdForm(ad) {
  const priceEl   = $("editUnitPrice");
  const timeoutEl = $("editTimeoutMin");
  const totalEl   = $("editBuyTotal");
  const fiat      = fiatLabel(ad.fiat);
  const amount    = Number(ad.amount || 0);

  if (priceEl)   priceEl.value   = ad.unitPrice || "";
  if (timeoutEl) timeoutEl.value = ad.timeoutMin || 30;

  function recalc() {
    const p = Number(priceEl?.value || 0);
    if (totalEl) totalEl.textContent = p > 0
      ? `예상 총액: ${Math.floor(amount * p).toLocaleString()} ${fiat}`
      : "";
  }
  priceEl?.addEventListener("input", recalc);
  recalc();
}

// BUY ad: 광고 수정 저장
async function doEditBuyAd() {
  const newPrice   = Number($("editUnitPrice")?.value || 0);
  const newTimeout = Number($("editTimeoutMin")?.value || 30);
  if (!newPrice || newPrice <= 0) return setNote("단가를 올바르게 입력하세요.", true);

  const adDocId = adIdParam || orderId;
  if (!adDocId) return setNote("광고 ID를 찾을 수 없습니다.", true);

  try {
    const amount   = Number(adData.amount || 0);
    const fiatAmt  = Math.floor(amount * newPrice);
    await updateDoc(doc(db, "ads", String(adDocId)), {
      unitPrice:  newPrice,
      fiatAmount: fiatAmt,
      timeoutMin: newTimeout,
      updatedAt:  serverTimestamp(),
    });
    setNote("광고가 수정되었습니다.");
    await loadTrade();
  } catch (e) {
    setNote(e?.message || String(e), true);
  }
}

// BUY ad: 광고 취소 (온체인 없음 — Firestore만)
async function doCancelBuyAd() {
  if (!confirm("구매 광고를 취소하시겠습니까?")) return;
  const adDocId = adIdParam || orderId;
  if (!adDocId) return setNote("광고 ID를 찾을 수 없습니다.", true);
  try {
    await updateDoc(doc(db, "ads", String(adDocId)), {
      status:    "CANCELED",
      updatedAt: serverTimestamp(),
    });
    showCancelModal(
      "광고가 취소되었습니다",
      "구매 광고가 성공적으로 취소되었습니다.",
      () => { location.href = "/sell.html"; }
    );
  } catch (e) {
    setNote(e?.message || String(e), true);
  }
}

// BUY ad: designated buyer confirms → acceptTrade → TAKEN
async function doBuyerConfirm() {
  setNote("");
  if (!activeAccount()) await connectWallet();
  const tradeId = Number(tradeIdParam || adData?.tradeId);
  if (!tradeId) return setNote("거래 ID를 찾을 수 없습니다.", true);

  // buyAmount = on-chain amount (already set by seller in openTrade)
  const dec = CONFIG.TOKENS?.HEX?.decimals ?? 18;
  const rawAmount = chainData?.amount ?? chainData?.[2] ?? 0n;
  const buyAmtWei = BigInt(rawAmount.toString());
  if (!buyAmtWei) return setNote("거래 수량을 확인할 수 없습니다.", true);

  try {
    if (window.jumpWallet) {
      setNote("거래 수락(acceptTrade) 전송 중 (Jump)…");
      await jumpSendTx(CONFIG.CONTRACT.vetEX, ABI, "acceptTrade", [tradeId, buyAmtWei.toString()]);
    } else {
      const c  = new ethers.Contract(CONFIG.CONTRACT.vetEX, ABI, signer);
      setNote("거래 수락(acceptTrade) 전송 중…");
      const tx = await c.acceptTrade(tradeId, buyAmtWei);
      await tx.wait();
    }
    // Update Firestore
    const adDocId = adData?.docId || adIdParam;
    if (adDocId) await updateDoc(doc(db, "ads", String(adDocId)), {
      status: "TAKEN", updatedAt: serverTimestamp(),
    }).catch(() => {});
    if (orderId) await updateDoc(doc(db, "orders", String(orderId)), {
      status: "TAKEN", updatedAt: serverTimestamp(),
    }).catch(() => {});
    setNote("거래 수락 완료! 판매자 계좌로 입금 후 '입금 완료'를 눌러주세요.");
    await loadTrade();
  } catch (e) {
    console.error(e);
    setNote(e?.shortMessage || e?.message || String(e), true);
  }
}

// Buyer: cancel (timeout elapsed)
async function doCancelByBuyer() {
  if (!confirm("타임아웃으로 거래를 취소하시겠습니까? 에스크로된 HEX는 판매자에게 반환됩니다.")) return;
  setNote("");
  if (!activeAccount()) await connectWallet();
  const tradeId = Number(tradeIdParam || adData?.tradeId);
  try {
    if (window.jumpWallet) {
      setNote("거래 취소(cancelByBuyer) 전송 중 (Jump)…");
      await jumpSendTx(CONFIG.CONTRACT.vetEX, ABI, "cancelByBuyer", [tradeId]);
    } else {
      const c  = new ethers.Contract(CONFIG.CONTRACT.vetEX, ABI, signer);
      setNote("거래 취소(cancelByBuyer) 전송 중…");
      const tx = await c.cancelByBuyer(tradeId);
      await tx.wait();
    }
    const adDocId = tradeIdParam || adIdParam;
    if (adDocId) await updateDoc(doc(db, "ads", String(adDocId)), { status: "CANCELED", updatedAt: serverTimestamp() });
    if (orderId) await updateDoc(doc(db, "orders", String(orderId)), { status: "CANCELED", canceledBy: "buyer", updatedAt: serverTimestamp() }).catch(()=>{});

    await updateTradeStats(adData?.buyer, false);

    setNote("거래가 취소되었습니다. (구매자 취소)");
    await loadTrade();
  } catch (e) {
    console.error(e);
    setNote(e?.shortMessage || e?.message || String(e), true);
  }
}

// Seller: cancel open ad (no buyer yet) — reclaim escrowed HEX
async function doCancelOpen() {
  if (!confirm("광고를 취소하고 에스크로된 HEX를 회수하시겠습니까?")) return;
  setNote("");
  if (!activeAccount()) await connectWallet();
  const tradeId = Number(tradeIdParam || adData?.tradeId);
  try {
    if (window.jumpWallet) {
      setNote("광고 취소(cancelBySeller) 전송 중 (Jump)…");
      await jumpSendTx(CONFIG.CONTRACT.vetEX, ABI, "cancelBySeller", [tradeId]);
    } else {
      const c  = new ethers.Contract(CONFIG.CONTRACT.vetEX, ABI, signer);
      setNote("광고 취소(cancelBySeller) 전송 중…");
      const tx = await c.cancelBySeller(tradeId);
      await tx.wait();
    }
    const adDocId = tradeIdParam || adIdParam;
    if (adDocId) await updateDoc(doc(db, "ads", String(adDocId)), { status: "CANCELED", updatedAt: serverTimestamp() });
    showCancelModal(
      "광고가 취소되었습니다",
      "에스크로된 HEX가 지갑으로 반환되었습니다.",
      () => { location.href = "/sell.html"; }
    );
  } catch (e) {
    console.error(e);
    setNote(e?.shortMessage || e?.message || String(e), true);
  }
}

// Seller: dispute
async function doDispute() {
  setNote("");
  if (!activeAccount()) await connectWallet();
  const tradeId = Number(tradeIdParam || adData?.tradeId);
  try {
    if (window.jumpWallet) {
      setNote("분쟁 신청(dispute) 전송 중 (Jump)…");
      await jumpSendTx(CONFIG.CONTRACT.vetEX, ABI, "dispute", [tradeId]);
    } else {
      const c  = new ethers.Contract(CONFIG.CONTRACT.vetEX, ABI, signer);
      setNote("분쟁 신청(dispute) 전송 중…");
      const tx = await c.dispute(tradeId);
      await tx.wait();
    }
    setNote("분쟁이 접수되었습니다. 관리자에게 문의하세요.");
    await loadTrade();
  } catch (e) {
    console.error(e);
    setNote(e?.shortMessage || e?.message || String(e), true);
  }
}

// ── Boot ──────────────────────────────────────────────────────────────────────
$("btnConnect")?.addEventListener("click", async () => {
  try {
    await connectWallet();
    if (adData) {
      renderRoleBadge(adData, activeAccount());
      const chainSt = chainData ? Number(chainData.status ?? chainData[11] ?? 0) : -1;
      renderActions(adData, chainSt);
      subscribeMessages(orderId, activeAccount());
    }
  } catch (e) { setNote(e.message, true); }
});

$("btnAccept")?.addEventListener("click",        doAccept);
$("btnSellerAccept")?.addEventListener("click",  doSellerAccept);
$("btnBuyerConfirm")?.addEventListener("click",  doBuyerConfirm);
$("btnPaid")?.addEventListener("click",         doPaid);
$("btnRelease")?.addEventListener("click",      doRelease);
$("btnCancelOpen")?.addEventListener("click",   doCancelOpen);
$("btnCancel")?.addEventListener("click",         doCancel);
$("btnCancelByBuyer")?.addEventListener("click", doCancelByBuyer);
$("btnCleanupGhost")?.addEventListener("click",  doCleanupGhost);
$("btnEditBuyAd")?.addEventListener("click",    doEditBuyAd);
$("btnCancelBuyAd")?.addEventListener("click",  doCancelBuyAd);
$("btnDispute")?.addEventListener("click",        doDispute);
$("btnSendMsg")?.addEventListener("click",      () => sendMessage(orderId));
$("chatInput")?.addEventListener("keydown",     e => { if (e.key === "Enter") sendMessage(orderId); });

// ── 통합 지갑 자동 연결 ──────────────────────────────────────────────────────
async function _onTradeWalletConnected(addr, type) {
  if (!addr || account) return;
  const isJump = type === 'jump' || !!window.jumpWallet;
  if (!isJump && window.ethereum) {
    try {
      provider = new ethers.BrowserProvider(window.ethereum);
      signer   = await provider.getSigner();
    } catch (_) {}
  }
  account = isJump ? window.jumpWallet?.address || addr : addr;
  const tag = isJump ? "📧 " : "🦊 ";
  $("walletAddr").textContent = tag + account.slice(0,6) + "…" + account.slice(-4);
  $("btnConnect").textContent = "연결됨";
  $("btnConnect").disabled    = true;
  if (adData) {
    renderRoleBadge(adData, account);
    const chainSt = chainData ? Number(chainData.status ?? chainData[11] ?? 0) : -1;
    renderActions(adData, chainSt);
    subscribeMessages(orderId, account);
  }
}

// 헤더 지갑이 이미 복원된 경우
const _initAddr = window.__hdrWallet?.address || window.jumpWallet?.address;
if (_initAddr) {
  const _type = window.jumpWallet ? 'jump' : 'metamask';
  _onTradeWalletConnected(_initAddr, _type);
}
// 비동기 복원 이벤트 수신
window.addEventListener('wallet:connected', e => _onTradeWalletConnected(e.detail?.address, e.detail?.type));
window.addEventListener('jump:connected',   e => _onTradeWalletConnected(e.detail?.address, 'jump'));
// 페이지 버튼 → 헤더 지갑에 위임
$("btnConnect")?.addEventListener("click", () => window.__hdrWallet?.connect());

await loadTrade();
dbg("trade.js ready");
