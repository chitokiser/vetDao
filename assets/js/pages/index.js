// /assets/js/pages/index.js
import {
  collection, query, where, orderBy, limit,
  getDocs, doc, getDoc,
} from "https://www.gstatic.com/firebasejs/10.7.0/firebase-firestore.js";

await window.firebaseReady;

const db     = window.db;
const ethers = window.ethers;
const CONFIG = window.CONFIG;
const ABI    = window.ABI;

const adList = document.getElementById("adList");

// ── State ─────────────────────────────────────────────────────────────────────
let allAds   = [];
let fiatFilter = "KRW";
let sortKey    = "price_asc";
let activeTab  = "SELL"; // "SELL" = 구매 탭 (SELL ads), "BUY" = 판매 탭 (BUY ads)

// ── PM label map ──────────────────────────────────────────────────────────────
const PM_LABEL = {
  BANK_KR: "🏦 KRW계좌",
  BANK_VN: "🏦 VND계좌",
  CASH:    "💵 현금",
  QR:      "📱 QR",
};

// ── Online status ─────────────────────────────────────────────────────────────
function onlineStatus(lastSeen) {
  if (!lastSeen) return { cls: "offline", label: "오프라인" };
  const ms   = lastSeen?.toMillis ? lastSeen.toMillis() : Number(lastSeen);
  const diff = Date.now() - ms;
  if (diff < 5 * 60 * 1000)  return { cls: "online",  label: "온라인" };
  if (diff < 30 * 60 * 1000) return { cls: "away",    label: "잠시 자리비움" };
  return { cls: "offline", label: "오프라인" };
}

// Fetch lastSeen + trade stats for a list of addresses (batch)
async function fetchSellerStatus(addresses) {
  const map = {};
  await Promise.allSettled(
    [...new Set(addresses)].map(async addr => {
      try {
        const snap = await getDoc(doc(db, "users", addr.toLowerCase()));
        if (snap.exists()) {
          const d = snap.data();
          map[addr.toLowerCase()] = {
            lastSeen:       d.lastSeen       ?? null,
            totalTrades:    d.totalTrades    ?? 0,
            completedTrades: d.completedTrades ?? 0,
          };
        }
      } catch {}
    })
  );
  return map;
}

function tradeStatsBadge(info) {
  if (!info) return "";
  const total   = info.totalTrades    ?? 0;
  const done    = info.completedTrades ?? 0;
  const rate    = total > 0 ? Math.round((done / total) * 100) : null;
  const rateStr = rate !== null ? `${rate}%` : "-";
  return `<span style="font-size:10px;color:#94a3b8;margin-left:4px;">📊 ${total}건 · ${rateStr}</span>`;
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function shortAddr(a) { return a ? a.slice(0,6) + "…" + a.slice(-4) : "-"; }
function fmtNum(n)    { const v = Number(n); return Number.isFinite(v) ? v.toLocaleString() : "-"; }
function fmtFiat(c)   {
  if (c === 0 || c === "0" || c === "KRW") return "KRW";
  if (c === 1 || c === "1" || c === "VND") return "VND";
  return String(c ?? "-");
}

// ── Sort & filter ─────────────────────────────────────────────────────────────
function applyFilter(ads) {
  return ads.filter(ad => {
    const matchType = (activeTab === "SELL") ? (ad.type === "SELL" || !ad.type) : (ad.type === "BUY");
    const matchFiat = !fiatFilter || fmtFiat(ad.fiat) === fiatFilter;
    return matchType && matchFiat;
  });
}
function applySort(ads) {
  const copy = [...ads];
  if (sortKey === "price_asc")   copy.sort((a,b) => (a.unitPrice??0) - (b.unitPrice??0));
  if (sortKey === "price_desc")  copy.sort((a,b) => (b.unitPrice??0) - (a.unitPrice??0));
  if (sortKey === "amount_desc") copy.sort((a,b) => (b.amount??0) - (a.amount??0));
  if (sortKey === "newest")      copy.sort((a,b) => {
    const ta = a.createdAt?.toMillis?.() ?? Number(a.createdAt ?? 0);
    const tb = b.createdAt?.toMillis?.() ?? Number(b.createdAt ?? 0);
    return tb - ta;
  });
  return copy;
}

// ── Render SELL ads (구매 탭) ──────────────────────────────────────────────────
function renderSellAds(ads, statusMap) {
  const visible = applySort(ads);
  adList.innerHTML = "";

  if (!visible.length) {
    adList.innerHTML = `<div class="p2p-empty">
      ${fiatFilter ? fiatFilter + " 통화의" : ""} 판매 광고가 없습니다.<br>
      <a href="/sell.html" style="color:#f97316; margin-top:8px; display:inline-block;">첫 판매자 되기 →</a>
    </div>`;
    return;
  }

  for (const ad of visible) {
    const fiat      = fmtFiat(ad.fiat);
    const adId      = ad.tradeId ?? ad.docId ?? "-";
    const ownerRaw  = (ad.seller || "").toLowerCase();
    const info      = statusMap[ownerRaw] ?? null;
    const { cls, label } = onlineStatus(info?.lastSeen ?? null);
    const initials  = ownerRaw ? ownerRaw.slice(2,4).toUpperCase() : "??";
    const pmTags    = (ad.paymentMethods || []).map(pm =>
      `<span class="pm-tag">${PM_LABEL[pm.type] ?? pm.type}</span>`
    ).join("");
    const minFiat = ad.minFiat ? fmtNum(ad.minFiat) : "0";
    const maxFiat = ad.maxFiat ? fmtNum(ad.maxFiat) : fmtNum(ad.fiatAmount);

    const row = document.createElement("div");
    row.className = "p2p-row";
    row.innerHTML = `
      <div class="seller-col">
        <div class="seller-avatar">${initials}</div>
        <div style="min-width:0;">
          <div style="display:flex;align-items:center;gap:6px;">
            <span class="seller-name mono">${shortAddr(ad.seller)}</span>
            <span class="online-dot ${cls}" title="${label}"></span>
          </div>
          <div class="seller-meta">${label} · HEX${tradeStatsBadge(info)}</div>
        </div>
      </div>
      <div>
        <div class="price-main">${fmtNum(ad.unitPrice)}</div>
        <div class="price-unit">${fiat} / HEX</div>
      </div>
      <div>
        <div class="limits-avail">
          <span class="muted" style="font-size:11px;">수량</span>
          <strong style="margin-left:4px;">${fmtNum(ad.amount)} HEX</strong>
        </div>
        <div class="limits-range">${minFiat} – ${maxFiat} ${fiat}</div>
        <div class="pm-tags">${pmTags}</div>
      </div>
      <div class="action-col">
        <button class="buy-btn" onclick="location.href='/trade.html?id=${encodeURIComponent(adId)}'">
          구매
        </button>
      </div>`;
    adList.appendChild(row);
  }
}

// ── Render BUY ads (판매 탭) ───────────────────────────────────────────────────
function renderBuyAds(ads, statusMap) {
  const visible = applySort(ads);
  adList.innerHTML = "";

  if (!visible.length) {
    adList.innerHTML = `<div class="p2p-empty">
      ${fiatFilter ? fiatFilter + " 통화의" : ""} 구매 광고가 없습니다.<br>
      <a href="/sell.html" style="color:#22c55e; margin-top:8px; display:inline-block;">구매 광고 등록하기 →</a>
    </div>`;
    return;
  }

  for (const ad of visible) {
    const fiat     = fmtFiat(ad.fiat);
    const adId     = ad.docId ?? "-";
    const ownerRaw = (ad.buyer || "").toLowerCase();
    const info     = statusMap[ownerRaw] ?? null;
    const { cls, label } = onlineStatus(info?.lastSeen ?? null);
    const initials = ownerRaw ? ownerRaw.slice(2,4).toUpperCase() : "??";
    const minFiat  = ad.minFiat ? fmtNum(ad.minFiat) : "0";
    const maxFiat  = ad.maxFiat ? fmtNum(ad.maxFiat) : fmtNum(ad.fiatAmount);

    const row = document.createElement("div");
    row.className = "p2p-row";
    row.innerHTML = `
      <div class="seller-col">
        <div class="seller-avatar" style="background:rgba(34,197,94,0.2);color:#22c55e;">${initials}</div>
        <div style="min-width:0;">
          <div style="display:flex;align-items:center;gap:6px;">
            <span class="seller-name mono">${shortAddr(ad.buyer)}</span>
            <span class="online-dot ${cls}" title="${label}"></span>
          </div>
          <div class="seller-meta">${label} · HEX${tradeStatsBadge(info)}</div>
        </div>
      </div>
      <div>
        <div class="price-main" style="color:#22c55e;">${fmtNum(ad.unitPrice)}</div>
        <div class="price-unit">${fiat} / HEX</div>
      </div>
      <div>
        <div class="limits-avail">
          <span class="muted" style="font-size:11px;">수량</span>
          <strong style="margin-left:4px;">${fmtNum(ad.amount)} HEX</strong>
        </div>
        <div class="limits-range">${minFiat} – ${maxFiat} ${fiat}</div>
      </div>
      <div class="action-col">
        <button class="buy-btn" style="background:#22c55e;"
          onclick="location.href='/trade.html?adId=${encodeURIComponent(adId)}&type=BUY'">
          판매
        </button>
      </div>`;
    adList.appendChild(row);
  }
}

// ── Render dispatcher ─────────────────────────────────────────────────────────
function renderAds(ads, statusMap = {}) {
  const filtered = applyFilter(ads);
  if (activeTab === "SELL") {
    renderSellAds(filtered, statusMap);
  } else {
    renderBuyAds(filtered, statusMap);
  }
}

// ── Load ──────────────────────────────────────────────────────────────────────
async function loadAds() {
  adList.innerHTML = `<div class="p2p-loading">불러오는 중…</div>`;
  try {
    const q    = query(collection(db, "ads"), where("status","==","OPEN"), orderBy("createdAt","desc"), limit(100));
    const snap = await getDocs(q);
    allAds = snap.docs.map(d => ({ docId: d.id, ...d.data() }));

    if (!allAds.length) {
      // Legacy fallback
      const addr    = (CONFIG?.CONTRACT?.vetEX || "").toLowerCase();
      const colName = addr ? "trades_" + addr : "trades";
      const q2  = query(collection(db, colName), orderBy("tradeId","desc"), limit(50));
      const s2  = await getDocs(q2);
      allAds = s2.docs.map(d => ({ ...d.data(), type: "SELL", status: "OPEN", paymentMethods: [] }));
    }

    // Fetch online status for all owners
    const addresses = allAds.map(a => a.seller || a.buyer).filter(Boolean);
    const statusMap = await fetchSellerStatus(addresses);
    _lastStatusMap  = statusMap;

    // Override chain status for SELL ads (top 20)
    const sellAds = allAds.filter(a => a.type === "SELL" || !a.type);
    await overrideChainStatuses(sellAds, 20);

    // Filter out non-OPEN chain-confirmed SELL ads
    allAds = allAds.filter(ad => {
      if (ad.type === "BUY") return true; // BUY ads have no on-chain status yet
      const s = ad._chainStatus ?? ad.status;
      return s === 0 || s === "OPEN";
    });

    renderAds(allAds, statusMap);
  } catch (e) {
    console.error(e);
    adList.innerHTML = `<div class="p2p-empty">로드 실패: ${e.message}</div>`;
  }
}

async function overrideChainStatuses(ads, max = 20) {
  if (!ethers || !ABI?.length || !CONFIG?.RPC_URL || !CONFIG?.CONTRACT?.vetEX) return;
  const rpc = new ethers.JsonRpcProvider(CONFIG.RPC_URL);
  const c   = new ethers.Contract(CONFIG.CONTRACT.vetEX, ABI, rpc);
  await Promise.allSettled(ads.slice(0, max).map(async ad => {
    const id = Number(ad.tradeId);
    if (!id) return;
    try { ad._chainStatus = Number((await c.getTrade(id)).status); } catch {}
  }));
}

// ── Tab switching ─────────────────────────────────────────────────────────────
document.getElementById("tabBuy")?.addEventListener("click", () => {
  activeTab = "SELL";
  document.getElementById("tabBuy")?.classList.add("active");
  document.getElementById("tabSell")?.classList.remove("active");
  renderAds(allAds, _lastStatusMap);
});

document.getElementById("tabSell")?.addEventListener("click", () => {
  activeTab = "BUY";
  document.getElementById("tabSell")?.classList.add("active");
  document.getElementById("tabBuy")?.classList.remove("active");
  renderAds(allAds, _lastStatusMap);
});

// ── Filter / sort controls ────────────────────────────────────────────────────
let _lastStatusMap = {};

document.querySelectorAll(".fiat-btn").forEach(btn => {
  btn.addEventListener("click", () => {
    fiatFilter = btn.dataset.fiat;
    document.querySelectorAll(".fiat-btn").forEach(b => b.classList.remove("active"));
    btn.classList.add("active");
    renderAds(allAds, _lastStatusMap);
  });
});

document.getElementById("sortBy")?.addEventListener("change", e => {
  sortKey = e.target.value;
  renderAds(allAds, _lastStatusMap);
});

// ── Real-time refresh (30초마다) ──────────────────────────────────────────────
async function refresh() {
  try {
    const q    = query(collection(db, "ads"), where("status","==","OPEN"), orderBy("createdAt","desc"), limit(100));
    const snap = await getDocs(q);
    allAds = snap.docs.map(d => ({ docId: d.id, ...d.data() }));
    const addresses = allAds.map(a => a.seller || a.buyer).filter(Boolean);
    _lastStatusMap  = await fetchSellerStatus(addresses);
    const sellAds   = allAds.filter(a => a.type === "SELL" || !a.type);
    await overrideChainStatuses(sellAds, 20);
    allAds = allAds.filter(ad => {
      if (ad.type === "BUY") return true;
      const s = ad._chainStatus ?? ad.status;
      return s === 0 || s === "OPEN";
    });
    renderAds(allAds, _lastStatusMap);
  } catch {}
}

// ── Boot ──────────────────────────────────────────────────────────────────────
await loadAds();
setInterval(refresh, 30_000);
