// /assets/js/header-wallet.js
// ethers는 UMD 전역(window.ethers) 사용

const USDT_ADDRESS = "0x9e5aac1ba1a2e6aed6b32689dfcf62a509ca96f3";
const HEX_ADDRESS  = "0x41F2Ea9F4eF7c4E35ba1a8438fC80937eD4E5464";
const VET_ADDRESS  = "0xff8eCA08F731EAe46b5e7d10eBF640A8Ca7BA3D4";

const ERC20_ABI = [
  "function balanceOf(address) view returns (uint256)",
  "function decimals() view returns (uint8)"
];

// vetEX 읽기 전용 (전체 ABI 없어도 됨)
const VETEX_READ_ABI = [
  "function nextTradeId() view returns (uint256)"
];

let provider = null;      // BrowserProvider (지갑)
let userAddress = null;

let readProvider = null;  // JsonRpcProvider (RPC 읽기)
let bound = false;
let dashBound = false;

function els() {
  return {
    // wallet buttons
    btnHeaderConnect: document.getElementById("hdrConnect"),
    btnPageConnect: document.getElementById("btnConnect"),

    // header compact balances
    boxHeaderBalances: document.getElementById("hdrBalances"),
    elHeaderAddr: document.getElementById("hdrAddr"),
    elHeaderHex: document.getElementById("hdrHex"),
    elHeaderUsdt: document.getElementById("hdrUsdt"),
    elHeaderVet: document.getElementById("hdrVet"),

    // page walletbar (optional)
    elPageAddr: document.getElementById("walletAddr"),
    elPageHex: document.getElementById("myHexBal"),
    elPageUsdt: document.getElementById("myUsdtBal"),
    elPageVet: document.getElementById("myVetBal"),

    // dashboard toggle UI (IMPORTANT)
    dashBtn: document.getElementById("hdrDashBtn"),
    dash: document.getElementById("hdrDash"),
    dashClose: document.getElementById("hdrDashClose"),

    // dashboard fields
    dashAddr: document.getElementById("hdrDashAddr"),
    dashMyHex: document.getElementById("hdrDashMyHex"),
    dashMyUsdt: document.getElementById("hdrDashMyUsdt"),
    dashMyVet: document.getElementById("hdrDashMyVet"),

    dashContract: document.getElementById("hdrDashContract"),
    dashCxHex: document.getElementById("hdrDashCxHex"),
    dashCxUsdt: document.getElementById("hdrDashCxUsdt"),
    dashCxVet: document.getElementById("hdrDashCxVet"),

    dashTrades: document.getElementById("hdrDashTrades"),
    dashNextId: document.getElementById("hdrDashNextId"),
    dashRpc: document.getElementById("hdrDashRpc"),
    dashUpdated: document.getElementById("hdrDashUpdated"),
  };
}

function markOnchain(el) {
  if (!el) return;
  el.classList.add("onchain");
}

function shortAddr(addr) {
  if (!addr) return "미연결";
  return `${addr.slice(0, 6)}...${addr.slice(-4)}`;
}

function setConnectLabel(connected) {
  const { btnHeaderConnect, btnPageConnect } = els();
  if (btnHeaderConnect) btnHeaderConnect.textContent = connected ? "연결됨" : "지갑 연결";
  if (btnPageConnect) btnPageConnect.textContent = connected ? "연결됨" : "지갑 연결";
}

function setAddr(addr) {
  const { elHeaderAddr, elPageAddr, dashAddr } = els();
  const s = shortAddr(addr);

  if (elHeaderAddr) { elHeaderAddr.textContent = s; markOnchain(elHeaderAddr); }
  if (elPageAddr) { elPageAddr.textContent = s; markOnchain(elPageAddr); }
  if (dashAddr) dashAddr.textContent = s;
}

function fmtUnitsSafe(value, decimals, maxFrac) {
  try {
    const n = Number(window.ethers.formatUnits(value, decimals));
    if (!Number.isFinite(n)) return "-";
    return n.toLocaleString(undefined, { maximumFractionDigits: maxFrac });
  } catch {
    return "-";
  }
}

function nowLabel() {
  const d = new Date();
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  const ss = String(d.getSeconds()).padStart(2, "0");
  return `${hh}:${mm}:${ss}`;
}

function getVetExAddress() {
  return window.CONFIG?.CONTRACT?.vetEX || null;
}

function ensureReadProvider() {
  if (readProvider) return readProvider;
  const rpc = window.CONFIG?.RPC_URL;
  if (!rpc || !window.ethers) return null;
  readProvider = new window.ethers.JsonRpcProvider(rpc);
  return readProvider;
}

function setBalances({ hexStr, usdtStr, vetStr }) {
  const {
    elHeaderHex, elHeaderUsdt, elHeaderVet,
    elPageHex, elPageUsdt, elPageVet,
    boxHeaderBalances,
    dashMyHex, dashMyUsdt, dashMyVet
  } = els();

  if (elHeaderHex) { elHeaderHex.textContent = hexStr; markOnchain(elHeaderHex); }
  if (elHeaderUsdt) { elHeaderUsdt.textContent = usdtStr; markOnchain(elHeaderUsdt); }
  if (elHeaderVet) { elHeaderVet.textContent = vetStr; markOnchain(elHeaderVet); }

  if (elPageHex) { elPageHex.textContent = hexStr; markOnchain(elPageHex); }
  if (elPageUsdt) { elPageUsdt.textContent = usdtStr; markOnchain(elPageUsdt); }
  if (elPageVet) { elPageVet.textContent = vetStr; markOnchain(elPageVet); }

  if (dashMyHex) { dashMyHex.textContent = hexStr; markOnchain(dashMyHex); }
  if (dashMyUsdt) { dashMyUsdt.textContent = usdtStr; markOnchain(dashMyUsdt); }
  if (dashMyVet) { dashMyVet.textContent = vetStr; markOnchain(dashMyVet); }

  if (boxHeaderBalances) boxHeaderBalances.style.display = "inline-flex";
}

async function loadWalletBalances() {
  if (!provider || !userAddress) return;

  const hex = new window.ethers.Contract(HEX_ADDRESS, ERC20_ABI, provider);
  const usdt = new window.ethers.Contract(USDT_ADDRESS, ERC20_ABI, provider);
  const vet = new window.ethers.Contract(VET_ADDRESS, ERC20_ABI, provider);

  const [
    hexBal, usdtBal, vetBal,
    hexDec, usdtDec, vetDec
  ] = await Promise.all([
    hex.balanceOf(userAddress),
    usdt.balanceOf(userAddress),
    vet.balanceOf(userAddress),
    hex.decimals(),
    usdt.decimals(),
    vet.decimals(),
  ]);

  setBalances({
    hexStr: fmtUnitsSafe(hexBal, hexDec, 4),
    usdtStr: fmtUnitsSafe(usdtBal, usdtDec, 2),
    vetStr: fmtUnitsSafe(vetBal, vetDec, 4),
  });
}

async function loadContractDashboard() {
  const {
    dashContract, dashCxHex, dashCxUsdt, dashCxVet,
    dashTrades, dashNextId, dashRpc, dashUpdated
  } = els();

  const vetEx = getVetExAddress();
  const rp = ensureReadProvider();
  const rpcUrl = window.CONFIG?.RPC_URL || "-";

  if (dashRpc) dashRpc.textContent = rpcUrl;

  if (!vetEx || !rp) {
    if (dashContract) dashContract.textContent = vetEx || "-";
    if (dashCxHex) dashCxHex.textContent = "-";
    if (dashCxUsdt) dashCxUsdt.textContent = "-";
    if (dashCxVet) dashCxVet.textContent = "-";
    if (dashTrades) dashTrades.textContent = "-";
    if (dashNextId) dashNextId.textContent = "-";
    if (dashUpdated) dashUpdated.textContent = nowLabel();
    return;
  }

  if (dashContract) dashContract.textContent = shortAddr(vetEx);

  const hex = new window.ethers.Contract(HEX_ADDRESS, ERC20_ABI, rp);
  const usdt = new window.ethers.Contract(USDT_ADDRESS, ERC20_ABI, rp);
  const vet = new window.ethers.Contract(VET_ADDRESS, ERC20_ABI, rp);
  const ex  = new window.ethers.Contract(vetEx, VETEX_READ_ABI, rp);

  const [
    cxHexBal, cxUsdtBal, cxVetBal,
    hexDec, usdtDec, vetDec,
    nextId
  ] = await Promise.all([
    hex.balanceOf(vetEx),
    usdt.balanceOf(vetEx),
    vet.balanceOf(vetEx),
    hex.decimals(),
    usdt.decimals(),
    vet.decimals(),
    ex.nextTradeId(),
  ]);

  if (dashCxHex) { dashCxHex.textContent = fmtUnitsSafe(cxHexBal, hexDec, 4); markOnchain(dashCxHex); }
  if (dashCxUsdt) { dashCxUsdt.textContent = fmtUnitsSafe(cxUsdtBal, usdtDec, 2); markOnchain(dashCxUsdt); }
  if (dashCxVet) { dashCxVet.textContent = fmtUnitsSafe(cxVetBal, vetDec, 4); markOnchain(dashCxVet); }

  const nid = Number(nextId);
  const tradeCount = Number.isFinite(nid) && nid > 0 ? nid - 1 : 0;

  if (dashNextId) { dashNextId.textContent = String(nid); markOnchain(dashNextId); }
  if (dashTrades) { dashTrades.textContent = tradeCount.toLocaleString(); markOnchain(dashTrades); }

  if (dashUpdated) dashUpdated.textContent = nowLabel();
}

async function connectWallet() {
  try {
    if (!window.ethereum) return alert("MetaMask가 설치되어 있지 않습니다.");
    if (!window.ethers) return alert("ethers 로드가 안되었습니다. ethers.umd.min.js 로드를 확인하세요.");

    provider = new window.ethers.BrowserProvider(window.ethereum);
    await provider.send("eth_requestAccounts", []);

    const signer = await provider.getSigner();
    userAddress = await signer.getAddress();

    setConnectLabel(true);
    setAddr(userAddress);
    await loadWalletBalances();

    const { dash } = els();
    if (dash && dash.classList.contains("open")) {
      await loadContractDashboard();
    }
  } catch (e) {
    console.error("[wallet] connect error:", e);
    alert(e?.message || "지갑 연결 실패");
  }
}

function bindWalletOnce() {
  if (bound) return;

  const { btnHeaderConnect, btnPageConnect } = els();
  const hasAny = !!btnHeaderConnect || !!btnPageConnect;
  if (!hasAny) return;

  if (btnHeaderConnect) btnHeaderConnect.addEventListener("click", connectWallet);
  if (btnPageConnect) btnPageConnect.addEventListener("click", connectWallet);

  if (window.ethereum?.on) {
    window.ethereum.on("accountsChanged", async (accs) => {
      userAddress = accs?.[0] || null;
      setAddr(userAddress);

      if (userAddress) {
        setConnectLabel(true);
        provider = new window.ethers.BrowserProvider(window.ethereum);
        await loadWalletBalances();
      } else {
        setConnectLabel(false);
        setBalances({ hexStr: "-", usdtStr: "-", vetStr: "-" });
      }
    });

    window.ethereum.on("chainChanged", () => {
      provider = new window.ethers.BrowserProvider(window.ethereum);
      readProvider = null;
    });
  }

  bound = true;
}

function bindDashOnce() {
  if (dashBound) return;

  const { dashBtn, dash, dashClose } = els();
  if (!dashBtn || !dash) return; // header 아직 안 꽂힘

  function openDash() {
    dash.classList.add("open");
    dashBtn.setAttribute("aria-expanded", "true");
    loadContractDashboard().catch(() => {});
    if (userAddress && provider) loadWalletBalances().catch(() => {});
  }

  function closeDash() {
    dash.classList.remove("open");
    dashBtn.setAttribute("aria-expanded", "false");
  }

  dashBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    if (dash.classList.contains("open")) closeDash();
    else openDash();
  });

  if (dashClose) dashClose.addEventListener("click", () => closeDash());

  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") closeDash();
  });

  dashBound = true;
}

function startBindWatcher() {
  let tries = 0;
  const t = setInterval(() => {
    bindWalletOnce();
    bindDashOnce();
    tries += 1;
    if ((bound && dashBound) || tries > 60) clearInterval(t);
  }, 50);
}

bindWalletOnce();
bindDashOnce();
startBindWatcher();

window.addEventListener("partials:loaded", () => {
  bindWalletOnce();
  bindDashOnce();
  startBindWatcher();
});

// 지갑 연결 없어도 계약 정보는 미리 채움
setTimeout(() => {
  loadContractDashboard().catch(() => {});
}, 200);
