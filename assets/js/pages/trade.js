// /assets/js/pages/trade.js
import {
  doc, getDoc, setDoc, addDoc, updateDoc,
  collection, query, orderBy, onSnapshot,
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
async function loadSellerSns(sellerAddr) {
  const el = $("vSellerSns");
  if (!el || !sellerAddr) return;
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
  ["sellerAcceptSection","btnSellerAccept","acceptSection","paidSection","btnRelease","btnCancel","btnCancelOpen","btnCancelByBuyer","btnDispute","editBuyAdSection"]
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

  // SELL ad — OPEN: seller can cancel/reclaim
  if ((ad.type !== "BUY") && st === 0 && isSeller) {
    show("btnCancelOpen");
    setGuide("📢 모집 중입니다. 광고를 취소하면 에스크로된 HEX가 반환됩니다.", false);
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
  if (btn) btn.disabled = true;
}

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
    // Try legacy
    setNote("광고 정보를 찾을 수 없습니다 (tradeId: " + tradeId + ")", true);
    adData = { type:"SELL", seller:null, amount:0, unitPrice:0, fiat:"KRW" };
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

  const chainSt = on ? Number(on.status ?? on[9] ?? 0) : 0;

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

  await loadSellerSns(adData.seller);
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

  await loadSellerSns(adData.buyer); // for BUY ad, show buyer's SNS
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

    // 3. Update ad doc: now has tradeId + seller
    await updateDoc(doc(db, "ads", adIdParam), {
      tradeId: newTradeId,
      seller:  me.toLowerCase(),
      status:  "TAKEN",
      updatedAt: serverTimestamp(),
    });

    // 4. Create order doc
    await setDoc(doc(db, "orders", String(newTradeId)), {
      tradeId:    newTradeId,
      adId:       adIdParam,
      type:       "BUY",
      seller:     me.toLowerCase(),
      buyer:      buyerAddr.toLowerCase(),
      status:     "TAKEN",
      escrowedAt: serverTimestamp(),
      createdAt:  serverTimestamp(),
      updatedAt:  serverTimestamp(),
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

    setNote("토큰 이체 완료! 거래가 완료되었습니다. 🎉");
    await loadTrade();
  } catch (e) {
    console.error(e);
    setNote(e?.shortMessage || e?.message || String(e), true);
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

    setNote("거래가 취소되었습니다.");
    await loadTrade();
  } catch (e) {
    console.error(e);
    setNote(e?.shortMessage || e?.message || String(e), true);
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
    setNote("광고가 취소되었습니다.");
    await loadTrade();
  } catch (e) {
    setNote(e?.message || String(e), true);
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
    setNote("광고가 취소되었습니다. 에스크로된 HEX가 반환되었습니다. ✅");
    await loadTrade();
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
      const chainSt = chainData ? Number(chainData.status ?? chainData[9] ?? 0) : -1;
      renderActions(adData, chainSt);
      subscribeMessages(orderId, activeAccount());
    }
  } catch (e) { setNote(e.message, true); }
});

$("btnAccept")?.addEventListener("click",       doAccept);
$("btnSellerAccept")?.addEventListener("click", doSellerAccept);
$("btnPaid")?.addEventListener("click",         doPaid);
$("btnRelease")?.addEventListener("click",      doRelease);
$("btnCancelOpen")?.addEventListener("click",   doCancelOpen);
$("btnCancel")?.addEventListener("click",         doCancel);
$("btnCancelByBuyer")?.addEventListener("click", doCancelByBuyer);
$("btnEditBuyAd")?.addEventListener("click",    doEditBuyAd);
$("btnCancelBuyAd")?.addEventListener("click",  doCancelBuyAd);
$("btnDispute")?.addEventListener("click",        doDispute);
$("btnSendMsg")?.addEventListener("click",      () => sendMessage(orderId));
$("chatInput")?.addEventListener("keydown",     e => { if (e.key === "Enter") sendMessage(orderId); });

// Jump auto-connect
window.addEventListener("jump:connected", async (e) => {
  if (!account && e.detail?.address) {
    account = e.detail.address;
    $("walletAddr").textContent = "📧 " + account.slice(0,6) + "…" + account.slice(-4);
    $("btnConnect").textContent = "연결됨";
    $("btnConnect").disabled    = true;
    if (adData) {
      renderRoleBadge(adData, account);
      const chainSt = chainData ? Number(chainData.status ?? chainData[9] ?? 0) : -1;
      renderActions(adData, chainSt);
      subscribeMessages(orderId, account);
    }
  }
});

// Auto-connect
if (window.jumpWallet?.address) {
  account = window.jumpWallet.address;
  $("walletAddr").textContent = "📧 " + account.slice(0,6) + "…" + account.slice(-4);
  $("btnConnect").textContent = "연결됨";
  $("btnConnect").disabled    = true;
} else if (window.ethereum) {
  try {
    const accs = await window.ethereum.request({ method: "eth_accounts" });
    if (accs.length) {
      provider = new ethers.BrowserProvider(window.ethereum);
      signer   = await provider.getSigner();
      account  = await signer.getAddress();
      $("walletAddr").textContent = "🦊 " + account.slice(0,6) + "…" + account.slice(-4);
      $("btnConnect").textContent = "연결됨";
      $("btnConnect").disabled    = true;
    }
  } catch (_) {}
}

await loadTrade();
dbg("trade.js ready");
