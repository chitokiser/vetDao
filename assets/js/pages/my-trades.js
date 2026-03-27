// /assets/js/pages/my-trades.js
import {
  collection, query, where,
  onSnapshot,
} from "https://www.gstatic.com/firebasejs/10.7.0/firebase-firestore.js";

await window.firebaseReady;

const db     = window.db;
const ethers = window.ethers;
const CONFIG = window.CONFIG;
const ABI    = window.ABI;

const $ = (id) => document.getElementById(id);

let myAddr   = null;
let activeTab = "sell"; // "sell" | "buy"
let allAds   = [];
let unsubSell = null;
let unsubBuy  = null;

// ── Helpers ───────────────────────────────────────────────────────────────────
function setNote(msg, isErr = false) {
  const el = $("note");
  if (!el) return;
  el.style.display = msg ? "block" : "none";
  el.textContent   = msg || "";
  el.style.borderLeft = isErr ? "3px solid var(--danger)" : "3px solid var(--primary)";
  el.style.color   = isErr ? "var(--danger)" : "";
}
function fmtNum(n)  { const v = Number(n); return Number.isFinite(v) ? v.toLocaleString() : "-"; }
function shortAddr(a) { return a ? a.slice(0,6) + "…" + a.slice(-4) : "-"; }
function fiatLabel(v) {
  if (v === 0 || v === "0" || v === "KRW") return "KRW";
  if (v === 1 || v === "1" || v === "VND") return "VND";
  return String(v ?? "-");
}

const STATUS_META = {
  OPEN:     { label: "모집중",    cls: "st-open",     icon: "🟠" },
  TAKEN:    { label: "거래중",    cls: "st-taken",    icon: "🟡", attention: true },
  PAID:     { label: "입금완료",  cls: "st-paid",     icon: "🟣", attention: true },
  RELEASED: { label: "거래완료",  cls: "st-released", icon: "🟢" },
  CANCELED: { label: "취소됨",    cls: "st-canceled", icon: "⚫" },
  DISPUTED: { label: "분쟁중",    cls: "st-paid",     icon: "🔴", attention: true },
};

function statusMeta(status) {
  return STATUS_META[String(status).toUpperCase()] ?? { label: status, cls: "st-open", icon: "⚪" };
}

function tradeUrl(ad) {
  if (ad.type === "BUY") {
    return ad.tradeId
      ? `/trade.html?id=${ad.tradeId}`
      : `/trade.html?adId=${ad.docId}&type=BUY`;
  }
  return `/trade.html?id=${ad.tradeId ?? ad.docId}`;
}

// ── Chain status override ─────────────────────────────────────────────────────
async function overrideChainStatus(ad) {
  if (ad.type === "BUY" && !ad.tradeId) return; // not yet on-chain
  const id = Number(ad.tradeId);
  if (!id || !ABI?.length || !CONFIG?.RPC_URL || !CONFIG?.CONTRACT?.vetEX) return;
  try {
    const rpc = new ethers.JsonRpcProvider(CONFIG.RPC_URL);
    const c   = new ethers.Contract(CONFIG.CONTRACT.vetEX, ABI, rpc);
    const on  = await c.getTrade(id);
    const n   = Number(on.status ?? on[11] ?? 0);
    const map = ["OPEN","TAKEN","PAID","RELEASED","CANCELED","DISPUTED","RESOLVED"];
    ad._chainStatus = map[n] ?? "OPEN";
  } catch {}
}

// ── Render ────────────────────────────────────────────────────────────────────
function render(ads) {
  const list = $("tradeList");
  if (!list) return;

  // Sort: attention first, then by createdAt desc
  const sorted = [...ads].sort((a, b) => {
    const aAtt = statusMeta(a._chainStatus || a.status).attention ? 1 : 0;
    const bAtt = statusMeta(b._chainStatus || b.status).attention ? 1 : 0;
    if (bAtt !== aAtt) return bAtt - aAtt;
    const ta = a.createdAt?.toMillis?.() ?? 0;
    const tb = b.createdAt?.toMillis?.() ?? 0;
    return tb - ta;
  });

  // Show attention banner if any trade needs action
  const needsAction = sorted.some(a => statusMeta(a._chainStatus || a.status).attention);
  const banner = $("attentionBanner");
  if (banner) banner.style.display = needsAction ? "block" : "none";

  if (!sorted.length) {
    list.innerHTML = `<div class="empty">
      ${activeTab === "sell" ? "등록한 판매 광고가 없습니다." : "등록한 구매 광고가 없습니다."}<br>
      <a href="/sell.html" style="color:#f97316; margin-top:8px; display:inline-block;">광고 등록하기 →</a>
    </div>`;
    return;
  }

  list.innerHTML = "";
  for (const ad of sorted) {
    const status  = ad._chainStatus || ad.status || "OPEN";
    const meta    = statusMeta(status);
    const fiat    = fiatLabel(ad.fiat);
    const origAmt   = ad.originalAmount || ad.amount;
    const curAmt    = ad.amount;
    const filledAmt = origAmt - curAmt;
    const isPartial = origAmt > 0 && filledAmt > 0;
    const amount    = isPartial
      ? `${fmtNum(curAmt)} <span style="font-size:12px;color:var(--muted);">(원래 ${fmtNum(origAmt)}, 체결 ${fmtNum(filledAmt)})</span>`
      : fmtNum(curAmt);
    const price   = fmtNum(ad.unitPrice);
    const total   = fmtNum(ad.fiatAmount || (ad.amount * ad.unitPrice));
    const partner = activeTab === "sell"
      ? (ad.buyer  ? shortAddr(ad.buyer)  : "구매자 대기 중")
      : (ad.seller ? shortAddr(ad.seller) : "판매자 대기 중");
    const partnerLabel = activeTab === "sell" ? "구매자" : "판매자";
    const tradeId = ad.tradeId ?? ad.docId ?? "-";
    const url     = tradeUrl(ad);

    const card = document.createElement("div");
    card.className = `trade-card ${meta.cls}` + (meta.attention ? " attention" : "");
    card.innerHTML = `
      <div class="type-col" style="font-size:22px; line-height:1;">${meta.icon}</div>
      <div class="info">
        <div class="title">
          <span class="st-badge ${meta.cls}" style="margin-right:8px;">${meta.label}</span>
          ${amount} HEX &nbsp;·&nbsp; ${price} ${fiat}
        </div>
        <div class="meta">
          총액 ${total} ${fiat}
          &nbsp;·&nbsp; ${partnerLabel}: <span class="mono">${partner}</span>
          &nbsp;·&nbsp; ID: ${tradeId}
          ${ad.terms ? `<br>📋 ${ad.terms}` : ""}
        </div>
      </div>
      <div style="display:flex; flex-direction:column; gap:6px; align-items:flex-end; flex-shrink:0;">
        ${meta.attention
          ? `<span style="font-size:11px; color:#fbbf24; font-weight:600;">액션 필요!</span>`
          : ""}
        <button class="btn primary" onclick="location.href='${url}'" style="padding:0 16px; height:36px; font-size:13px;">
          거래 보기 →
        </button>
      </div>`;
    list.appendChild(card);
  }
}

// ── Load ads (real-time) ──────────────────────────────────────────────────────
function subscribeAds(addr) {
  if (unsubSell) { unsubSell(); unsubSell = null; }
  if (unsubBuy)  { unsubBuy();  unsubBuy  = null; }

  const list = $("tradeList");
  if (list) list.innerHTML = `<div class="empty" style="padding:30px;">불러오는 중…</div>`;

  const addrLower = addr.toLowerCase();

  // 단일 필드 where → 복합 인덱스 불필요
  const qSell = query(collection(db, "ads"), where("seller", "==", addrLower));
  const qBuy  = query(collection(db, "ads"), where("buyer",  "==", addrLower));

  let sellAds = [];
  let buyAds  = [];

  async function mergeAndRender() {
    allAds = activeTab === "sell" ? sellAds : buyAds;
    // 클라이언트 정렬: createdAt 내림차순
    allAds.sort((a, b) => {
      const ta = a.createdAt?.toMillis?.() ?? 0;
      const tb = b.createdAt?.toMillis?.() ?? 0;
      return tb - ta;
    });
    await Promise.allSettled(allAds.map(ad => overrideChainStatus(ad)));
    render(allAds);
  }

  unsubSell = onSnapshot(qSell, async snap => {
    sellAds = snap.docs.map(d => ({ docId: d.id, ...d.data() }));
    if (activeTab === "sell") await mergeAndRender();
  }, err => { console.error("sell query:", err); setNote(err.message, true); });

  unsubBuy = onSnapshot(qBuy, async snap => {
    buyAds = snap.docs.map(d => ({ docId: d.id, ...d.data() }));
    if (activeTab === "buy") await mergeAndRender();
  }, err => {
    if (err.code === "failed-precondition") {
      setNote("인덱스 생성 필요: " + (err.message || "Firestore index required"), true);
    }
  });

  // Initial render trigger
  setTimeout(mergeAndRender, 500);
}

// ── Tab switch ────────────────────────────────────────────────────────────────
document.querySelectorAll(".tab-btn").forEach(btn => {
  btn.addEventListener("click", () => {
    activeTab = btn.dataset.tab;
    document.querySelectorAll(".tab-btn").forEach(b => b.classList.remove("active"));
    btn.classList.add("active");
    if (myAddr) subscribeAds(myAddr);
  });
});

// ── Wallet connect ────────────────────────────────────────────────────────────
function onWalletConnected(addr) {
  myAddr = addr.toLowerCase();
  const tag = window.jumpWallet ? "📧 " : "🦊 ";
  $("walletAddr").textContent = tag + addr.slice(0,6) + "…" + addr.slice(-4);
  $("btnConnect").textContent = "연결됨";
  $("btnConnect").disabled    = true;
  subscribeAds(myAddr);
}

// ── 통합 지갑 자동 연결 ──────────────────────────────────────────────────────
function _tryConnect(addr) {
  if (!addr || myAddr) return;
  onWalletConnected(addr);
}
// 헤더 지갑이 이미 복원된 경우
_tryConnect(window.__hdrWallet?.address || window.jumpWallet?.address);
// 비동기 복원 이벤트 (MetaMask / Jump 모두 수신)
window.addEventListener('wallet:connected', e => _tryConnect(e.detail?.address));
window.addEventListener('jump:connected',   e => _tryConnect(e.detail?.address));
// 페이지 버튼 → 헤더 지갑에 위임
$("btnConnect")?.addEventListener("click", () => window.__hdrWallet?.connect());
