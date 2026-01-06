import { ethers } from "https://cdn.jsdelivr.net/npm/ethers@6.14.0/dist/ethers.min.js";
import { ABI } from "../contract.js";

const CONFIG = window.CONFIG;
const tradeList = document.getElementById("tradeList");

function card(html) {
  tradeList.insertAdjacentHTML(
    "beforeend",
    `<div class="card" style="margin-top:10px;">${html}</div>`
  );
}

function fiatLabel(v) {
  return Number(v) === 0 ? "KRW" : "VND";
}

function tokenSymbolByAddr(addr) {
  const a = (addr || "").toLowerCase();
  const hex = CONFIG.TOKENS?.HEX?.address?.toLowerCase();
  const usdt = CONFIG.TOKENS?.USDT?.address?.toLowerCase();
  if (hex && a === hex) return "HEX";
  if (usdt && a === usdt) return "USDT";
  return addr;
}

function tokenDecimalsByAddr(addr) {
  const a = (addr || "").toLowerCase();
  const hex = CONFIG.TOKENS?.HEX?.address?.toLowerCase();
  const usdt = CONFIG.TOKENS?.USDT?.address?.toLowerCase();
  if (hex && a === hex) return CONFIG.TOKENS?.HEX?.decimals ?? 18;
  if (usdt && a === usdt) return CONFIG.TOKENS?.USDT?.decimals ?? 18;
  return 18;
}

async function loadOnchainTrades() {
  tradeList.innerHTML = "";
  card("로딩중...");

  const rpc = CONFIG.RPC_URL || "https://opbnb-mainnet-rpc.bnbchain.org";
  const provider = new ethers.JsonRpcProvider(rpc);
  const c = new ethers.Contract(CONFIG.CONTRACT.vetEX, ABI, provider);

  const latest = await provider.getBlockNumber();
  const fromBlock = Number(CONFIG.DEPLOY_BLOCK || 1);

  // opBNB 제한: eth_getLogs 최대 50,000 블록 범위
  const STEP = 50000;

  const filter = c.filters.TradeOpened();
  const logs = [];

  for (let start = fromBlock; start <= latest; start += STEP) {
    const end = Math.min(start + STEP - 1, latest);
    const part = await c.queryFilter(filter, start, end);
    logs.push(...part);
  }

  tradeList.innerHTML = "";

  if (!logs.length) {
    card("아직 등록된 거래가 없습니다. (on-chain 이벤트 기준)");
    return;
  }

  // 최신 우선
  logs.sort((a, b) => Number(b.blockNumber) - Number(a.blockNumber));

  for (const ev of logs) {
    const { tradeId, seller, token, amount, fiat } = ev.args;

    const sym = tokenSymbolByAddr(token);
    const dec = tokenDecimalsByAddr(token);
    const amountStr = ethers.formatUnits(amount, dec);
    const fiatSym = fiatLabel(fiat);

    const vetBadge =
      sym === "HEX"
        ? `<span class="pill" style="margin-left:8px;">VET 보상</span>`
        : "";

    card(`
      <div style="display:flex; justify-content:space-between; gap:12px;">
        <div>
          <div>${sym} ${amountStr} ${vetBadge}</div>
          <div style="margin-top:6px; color:var(--muted); font-size:12px;">
            결제통화: ${fiatSym}
          </div>
          <div style="margin-top:6px; color:var(--muted); font-size:12px;">
            seller: ${seller}
          </div>
          <div style="margin-top:6px; color:var(--muted); font-size:12px;">
            block: ${ev.blockNumber}
          </div>
        </div>
        <div style="display:flex; align-items:flex-end;">
          <a href="/trade.html?id=${tradeId}">상세</a>
        </div>
      </div>
    `);
  }
}

loadOnchainTrades().catch((e) => {
  console.error(e);
  tradeList.innerHTML = "";
  card(`ERROR<br/><pre style="white-space:pre-wrap;margin:0;">${e?.message || e}</pre>`);
});
