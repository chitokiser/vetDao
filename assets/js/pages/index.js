// /assets/js/pages/index.js
import {
  collection,
  query,
  orderBy,
  limit,
  getDocs,
} from "https://www.gstatic.com/firebasejs/10.7.0/firebase-firestore.js";

const ethers = window.ethers;
const CONFIG = window.CONFIG;
const ABI = window.ABI;
const db = window.db;

const $ = (id) => document.getElementById(id);
const tradeList = $("tradeList");

function el(tag, attrs = {}, children = []) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "class") n.className = v;
    else if (k === "html") n.innerHTML = v;
    else n.setAttribute(k, v);
  }
  for (const c of children) n.appendChild(typeof c === "string" ? document.createTextNode(c) : c);
  return n;
}

function renderEmpty(msg) {
  if (!tradeList) return;
  tradeList.innerHTML = "";
  tradeList.appendChild(el("div", { class: "pill", style: "padding:14px 16px;" }, [msg]));
}

function shortAddr(a) {
  if (!a) return "-";
  return `${a.slice(0, 6)}...${a.slice(-4)}`;
}

function fmtNumberLike(x) {
  const n = Number(x);
  if (Number.isFinite(n)) return n.toLocaleString();
  return String(x ?? "-");
}

function fmtFiat(fiatCode) {
  if (fiatCode === 0 || fiatCode === "0" || fiatCode === "KRW") return "KRW";
  if (fiatCode === 1 || fiatCode === "1" || fiatCode === "VND") return "VND";
  return "-";
}

function fmtStatusKo(s) {
  // 0=OPEN,1=TAKEN,2=PAID,3=RELEASED,4=CANCELED,5=DISPUTED,6=RESOLVED
  const map = ["판매중", "거래수락", "입금완료", "이체완료", "취소", "분쟁중", "분쟁해결"];
  const n = Number(s);
  if (Number.isFinite(n) && map[n]) return map[n];
  return "-";
}

function fmtStatusColor(s) {
  // 0=판매중(파랑), 1=거래수락(노랑), 2=입금완료(주황), 3=이체완료(초록), 4=취소(빨강), 5=분쟁중(분홍), 6=분쟁해결(회색)
  const map = ["#60a5fa", "#fbbf24", "#fb923c", "#22c55e", "#f87171", "#f43f5e", "#94a3b8"];
  const n = Number(s);
  return Number.isFinite(n) && map[n] ? map[n] : "var(--muted)";
}

function symbolFromAddress(addr) {
  const a = (addr || "").toLowerCase();
  const tok = CONFIG?.TOKENS || {};
  const usdt = (tok.USDT?.address || "").toLowerCase();
  const hex = (tok.HEX?.address || "").toLowerCase();
  const vet = (tok.VET?.address || "").toLowerCase();

  if (a && a === usdt) return "USDT";
  if (a && a === hex) return "HEX";
  if (a && a === vet) return "VET";
  return "-";
}

function safeNum(x) {
  const n = Number(x);
  return Number.isFinite(n) ? n : null;
}

function calcVetBonus(amountHex, feeBps, price) {
  // amountHex: HEX 토큰 수량(소수점 포함), feeBps: 수수료 bps, price: BigInt (HEX wei per 1 VET)
  if (!amountHex || !feeBps || !price || price === 0n) return null;
  try {
    const amtStr = Number(amountHex).toFixed(8);
    const amountWei = ethers.parseUnits(amtStr, 18);
    const feeWei = amountWei * BigInt(feeBps) / 10_000n;
    return Number(feeWei / price);
  } catch {
    return null;
  }
}

function calcTotalFiat(amount, unitPrice) {
  const a = safeNum(amount);
  const p = safeNum(unitPrice);
  if (a === null || p === null) return null;
  return a * p;
}

function tradesCollectionNameByContract() {
  const addr = (CONFIG?.CONTRACT?.vetEX || "").toLowerCase();
  if (!addr) return "trades";
  return "trades_" + addr;
}

async function fetchVetConfig() {
  if (!ethers || !CONFIG?.RPC_URL || !CONFIG?.CONTRACT?.vetEX || !ABI?.length) return null;
  try {
    const provider = new ethers.JsonRpcProvider(CONFIG.RPC_URL);
    const c = new ethers.Contract(CONFIG.CONTRACT.vetEX, ABI, provider);
    const [feeBps, vetBankAddr] = await Promise.all([c.feeBps(), c.vetBank()]);
    if (!vetBankAddr || vetBankAddr === ethers.ZeroAddress) return null;
    const vetBankAbi = ["function price() external view returns (uint256)"];
    const price = await new ethers.Contract(vetBankAddr, vetBankAbi, provider).price();
    if (!price || price === 0n) return null;
    return { feeBps: Number(feeBps), price };
  } catch (e) {
    console.warn("fetchVetConfig failed:", e);
    return null;
  }
}

/*
  ✅ 변경 1: 상태는 "비어있을 때만"이 아니라,
  Firestore에 뭐가 들어있든 최근 N개는 온체인 status로 항상 덮어쓴다.
*/
async function overrideStatusesFromChain(items, max = 30) {
  if (!ethers || !CONFIG?.RPC_URL || !CONFIG?.CONTRACT?.vetEX) return items;
  if (!ABI?.length) return items;
  if (!Array.isArray(items) || items.length === 0) return items;

  const provider = new ethers.JsonRpcProvider(CONFIG.RPC_URL);
  const c = new ethers.Contract(CONFIG.CONTRACT.vetEX, ABI, provider);

  const target = items.slice(0, Math.min(max, items.length));

  for (const t of target) {
    const id = Number(t.tradeId);
    if (!Number.isFinite(id) || id <= 0) continue;
    try {
      const on = await c.getTrade(id);
      t.status = Number(on.status);
    } catch (e) {
      console.warn("status override failed:", id, e);
    }
  }
  return items;
}

function renderTrades(items, sourceLabel, vetConfig = null) {
  if (!tradeList) return;
  tradeList.innerHTML = "";

  tradeList.appendChild(
    el("div", { class: "muted", style: "margin-bottom:8px; font-size:12px;" }, [
      `표시 기준: ${sourceLabel}`,
    ])
  );

  for (const t of items) {
    const tradeId = t.tradeId ?? "-";
    const seller = shortAddr(t.seller);

    const tokenSymbol =
      t.tokenSymbol ||
      symbolFromAddress(t.tokenAddress) ||
      symbolFromAddress(t.token) ||
      "-";

    const amountText =
      t.amountStr ??
      (safeNum(t.amount) !== null ? fmtNumberLike(t.amount) : String(t.amount ?? "-"));

    const fiat = t.fiatLabel || fmtFiat(t.fiat);

    let totalFiatText = "-";
    if (t.fiatAmount !== undefined && t.fiatAmount !== null && t.fiatAmount !== "") {
      totalFiatText = `${fmtNumberLike(t.fiatAmount)} ${fiat}`;
    } else {
      const total = calcTotalFiat(t.amount, t.unitPrice);
      if (total !== null) totalFiatText = `${fmtNumberLike(Math.round(total))} ${fiat}`;
    }

    const statusKo = fmtStatusKo(t.status);
    const statusColor = fmtStatusColor(t.status);
    const statusHtml = `<span style="color:${statusColor};font-weight:600;">${statusKo}</span>`;

    let vetBonusText = "";
    if (tokenSymbol === "HEX" && vetConfig) {
      const bonus = calcVetBonus(t.amount, vetConfig.feeBps, vetConfig.price);
      if (bonus !== null && bonus > 0) {
        vetBonusText = ` / VET보상: +${bonus.toLocaleString()} VET`;
      }
    }

    const tokenColor =
      tokenSymbol === "HEX" ? "#f97316" :
      tokenSymbol === "USDT" ? "#22c55e" :
      "var(--muted)";

    const tokenBadgeHtml = `<span style="color:${tokenColor};font-weight:700;">${tokenSymbol}</span>`;
    const line1Html =
      `판매토큰: ${tokenBadgeHtml} / 판매개수: ${amountText}${vetBonusText} / 판매금액: ${totalFiatText} / 진행상태: ${statusHtml}`;

    const unitPriceText =
      t.unitPrice !== undefined && t.unitPrice !== null && t.unitPrice !== ""
        ? `${fmtNumberLike(t.unitPrice)} ${fiat}`
        : "-";

    const line2 = `판매자: ${seller} · 단가: ${unitPriceText}`;

    const card = el("div", { class: "card", style: `margin-top:10px; border-left:3px solid ${tokenColor};` }, [
      el(
        "div",
        { class: "card-inner", style: "display:flex; justify-content:space-between; gap:12px; align-items:center;" },
        [
          el("div", {}, [
            el("div", { class: "k", style: "font-size:13px; color:var(--muted);" }, [`tradeId #${tradeId}`]),
            el("div", { class: "v onchain", html: line1Html, style: "font-size:15px; margin-top:2px; line-height:1.35;" }, []),
            el("div", { class: "muted", style: "font-size:12px; margin-top:6px;" }, [line2]),
          ]),
          el("a", { class: "btn", href: `/trade.html?id=${encodeURIComponent(tradeId)}` }, ["상세보기"]),
        ]
      ),
    ]);

    tradeList.appendChild(card);
  }
}

/*
  ✅ 변경 2: Firestore는 trades + trades_{컨트랙트} 둘 다 읽어서 합친다.
  (중복 tradeId는 1개로 유지)
  => 누가 접속하든 리스트가 동일하게 보임
*/
async function loadFromFirestoreAll() {
  if (!db) return { items: [], sources: [] };

  const cols = [];
  cols.push("trades");
  const byContract = tradesCollectionNameByContract();
  if (byContract && byContract !== "trades") cols.push(byContract);

  const sources = [];

  const results = await Promise.allSettled(
    cols.map(async (colName) => {
      const q = query(collection(db, colName), orderBy("tradeId", "desc"), limit(60));
      const snap = await getDocs(q);
      const arr = [];
      snap.forEach((d) => arr.push({ ...d.data(), __col: colName }));
      sources.push(colName);
      return arr;
    })
  );

  const merged = new Map(); // tradeId -> doc
  for (const r of results) {
    if (r.status !== "fulfilled") continue;
    for (const item of r.value) {
      const id = Number(item.tradeId);
      if (!Number.isFinite(id) || id <= 0) continue;

      // 동일 tradeId가 두 컬렉션에 있으면 "updatedAt"이 더 최신인 걸 우선(없으면 기존 유지)
      const prev = merged.get(id);
      if (!prev) {
        merged.set(id, item);
        continue;
      }

      const p = prev?.updatedAt?.toMillis ? prev.updatedAt.toMillis() : Number(prev?.updatedAt || 0);
      const n = item?.updatedAt?.toMillis ? item.updatedAt.toMillis() : Number(item?.updatedAt || 0);
      if (Number.isFinite(n) && n >= (Number.isFinite(p) ? p : 0)) {
        merged.set(id, item);
      }
    }
  }

  const items = Array.from(merged.values()).sort((a, b) => Number(b.tradeId) - Number(a.tradeId));
  return { items, sources };
}

// 체인 fallback: 최근 tradeId를 getTrade로 직접 조회
async function loadFromChainByStorage() {
  if (!ethers || !CONFIG?.RPC_URL || !CONFIG?.CONTRACT?.vetEX) return [];
  if (!ABI?.length) return [];

  const provider = new ethers.JsonRpcProvider(CONFIG.RPC_URL);
  const c = new ethers.Contract(CONFIG.CONTRACT.vetEX, ABI, provider);

  const decCache = new Map();
  const ERC20_ABI = ["function decimals() view returns (uint8)"];

  async function getDecimals(tokenAddr) {
    const key = (tokenAddr || "").toLowerCase();
    if (decCache.has(key)) return decCache.get(key);
    try {
      const erc = new ethers.Contract(tokenAddr, ERC20_ABI, provider);
      const d = await erc.decimals();
      const dn = Number(d);
      decCache.set(key, dn);
      return dn;
    } catch {
      decCache.set(key, 18);
      return 18;
    }
  }

  let nextId;
  try {
    nextId = await c.nextTradeId();
  } catch {
    nextId = await c.nextTradeId?.() ?? 1;
  }

  const next = Number(nextId);
  if (!Number.isFinite(next) || next <= 1) return [];

  const latestId = next - 1;
  const startId = Math.max(1, latestId - 29);

  const items = [];
  for (let id = latestId; id >= startId; id--) {
    try {
      const t = await c.getTrade(id);

      const seller = t.seller;
      const tokenAddr = t.token;
      const amountRaw = t.amount;
      const fiatAmountRaw = t.fiatAmount;

      const fiat = Number(t.fiat);
      const status = Number(t.status);

      const dec = await getDecimals(tokenAddr);
      const amountNum = Number(ethers.formatUnits(amountRaw, dec));
      const amountStr = Number.isFinite(amountNum)
        ? amountNum.toLocaleString(undefined, { maximumFractionDigits: 6 })
        : "-";

      const fiatAmount = Number(fiatAmountRaw);
      const unitPrice =
        Number.isFinite(amountNum) && amountNum > 0 && Number.isFinite(fiatAmount)
          ? Math.round(fiatAmount / amountNum)
          : "";

      items.push({
        tradeId: id,
        seller,
        tokenAddress: tokenAddr,
        tokenSymbol: symbolFromAddress(tokenAddr),
        amount: amountNum,
        amountStr,
        fiatAmount: Number.isFinite(fiatAmount) ? fiatAmount : String(fiatAmountRaw),
        unitPrice,
        fiat,
        fiatLabel: fmtFiat(fiat),
        status,
      });
    } catch (e) {
      console.warn("chain getTrade failed:", id, e);
    }
  }

  return items;
}

async function boot() {
  if (!tradeList) return;

  const vetConfig = await fetchVetConfig();

  // 1) Firestore(전체) 우선: trades + trades_{contract} 병합
  try {
    const { items: fsItems, sources } = await loadFromFirestoreAll();
    if (fsItems.length > 0) {
      // 표시 상태는 항상 온체인을 우선
      await overrideStatusesFromChain(fsItems, 30);
      renderTrades(fsItems.slice(0, 30), `Firestore(${sources.join(",")}) + onchain(status override)`, vetConfig);
      return;
    }
  } catch (e) {
    console.warn("firestore load failed", e);
  }

  // 2) 체인 storage fallback
  try {
    const chainItems = await loadFromChainByStorage();
    if (chainItems.length > 0) {
      renderTrades(chainItems, "Chain(storage: getTrade)", vetConfig);
      return;
    }
  } catch (e) {
    console.warn("chain load failed", e);
  }

  renderEmpty("아직 등록된 거래가 없습니다. (Firestore/체인 기준)");
}

boot();
