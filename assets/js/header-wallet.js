// /assets/js/header-wallet.js
// ethers는 UMD 전역(window.ethers) 사용
const ethers = window.ethers;

const USDT_ADDRESS = "0x9e5aac1ba1a2e6aed6b32689dfcf62a509ca96f3";
const HEX_ADDRESS  = "0x41F2Ea9F4eF7c4E35ba1a8438fC80937eD4E5464"; // ✅ FIX: 원래 HEX 주소
const VET_ADDRESS  = "0xff8eCA08F731EAe46b5e7d10eBF640A8Ca7BA3D4";

const ERC20_ABI = [
  "function balanceOf(address) view returns (uint256)",
  "function decimals() view returns (uint8)",
];

const VETEX_READ_ABI = [
  "function nextTradeId() view returns (uint256)",
  "function pendingUsdtFee() view returns (uint256)",
  "function pendingHexFee() view returns (uint256)",
];

let provider = null;
let userAddress = null;

let readProvider = null;
let boundWallet = false;
let boundUi = false;

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

    // UI buttons (burger / dash)
    burger: document.getElementById("hdrBurger"),
    menu: document.getElementById("hdrMenu"),

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

    // pending fee fields (header.html에 id가 있어야 표시됨)
    dashPendingUsdt: document.getElementById("hdrDashPendingUsdt"),
    dashPendingHex: document.getElementById("hdrDashPendingHex"),

    hdrNote: document.getElementById("hdrNote"),
  };
}

function note(msg, type = "") {
  const { hdrNote } = els();
  if (!hdrNote) return;
  hdrNote.style.display = msg ? "block" : "none";
  hdrNote.className = "note" + (type ? " " + type : "");
  hdrNote.textContent = msg || "";
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
    const n = Number(ethers.formatUnits(value ?? 0n, Number(decimals ?? 18)));
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
  if (!rpc || !ethers) return null;
  readProvider = new ethers.JsonRpcProvider(rpc);
  return readProvider;
}

async function isContract(rp, addr) {
  try {
    if (!rp || !addr) return false;
    const code = await rp.getCode(addr);
    return code && code !== "0x";
  } catch {
    return false;
  }
}

async function readDecimalsSafe(rp, tokenAddr, fallbackDecimals) {
  const fallback = Number.isFinite(Number(fallbackDecimals)) ? Number(fallbackDecimals) : 18;
  const ok = await isContract(rp, tokenAddr);
  if (!ok) return fallback;
  try {
    const t = new ethers.Contract(tokenAddr, ERC20_ABI, rp);
    const d = await t.decimals();
    const dn = Number(d);
    return Number.isFinite(dn) ? dn : fallback;
  } catch {
    return fallback;
  }
}

async function readBalanceSafe(rp, tokenAddr, ownerAddr) {
  try {
    if (!rp || !tokenAddr || !ownerAddr) return 0n;
    const ok = await isContract(rp, tokenAddr);
    if (!ok) return 0n;
    const t = new ethers.Contract(tokenAddr, ERC20_ABI, rp);
    return (await t.balanceOf(ownerAddr)) ?? 0n;
  } catch {
    return 0n;
  }
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

  const rp = ensureReadProvider() || provider;

  const hexDec  = await readDecimalsSafe(rp, HEX_ADDRESS,  window.CONFIG?.TOKENS?.HEX?.decimals ?? 18);
  const usdtDec = await readDecimalsSafe(rp, USDT_ADDRESS, window.CONFIG?.TOKENS?.USDT?.decimals ?? 6);
  const vetDec  = await readDecimalsSafe(rp, VET_ADDRESS,  window.CONFIG?.TOKENS?.VET?.decimals ?? 0);

  const [hexBal, usdtBal, vetBal] = await Promise.all([
    readBalanceSafe(rp, HEX_ADDRESS, userAddress),
    readBalanceSafe(rp, USDT_ADDRESS, userAddress),
    readBalanceSafe(rp, VET_ADDRESS, userAddress),
  ]);

  setBalances({
    hexStr: fmtUnitsSafe(hexBal,  hexDec,  4),
    usdtStr: fmtUnitsSafe(usdtBal, usdtDec, 2),
    vetStr: fmtUnitsSafe(vetBal,  vetDec,  4),
  });
}

async function loadContractDashboard() {
  const {
    dashContract, dashCxHex, dashCxUsdt, dashCxVet,
    dashTrades, dashNextId, dashRpc, dashUpdated,
    dashPendingUsdt, dashPendingHex
  } = els();

  const vetEx = getVetExAddress();

  // ✅ 계약/대시보드 온체인 읽기는 readProvider 고정 (안정성)
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
  if (dashPendingUsdt) { dashPendingUsdt.textContent = fmtUnitsSafe(pendingUsdt ?? 0n, 18, 4); markOnchain(dashPendingUsdt); }
  if (dashPendingHex)  { dashPendingHex.textContent  = fmtUnitsSafe(pendingHex  ?? 0n, 18, 4); markOnchain(dashPendingHex); }
  if (dashUpdated) dashUpdated.textContent = nowLabel();
    return;
  }

  if (dashContract) dashContract.textContent = shortAddr(vetEx);

  // 계약주소가 실제 컨트랙트인지 먼저 확인 (0이면 주소가 잘못되었을 가능성 큼)
  const isVetExContract = await isContract(rp, vetEx);
  if (!isVetExContract) {
    if (dashCxHex) dashCxHex.textContent = "주소오류";
    if (dashCxUsdt) dashCxUsdt.textContent = "주소오류";
    if (dashCxVet) dashCxVet.textContent = "주소오류";
    if (dashTrades) dashTrades.textContent = "-";
    if (dashNextId) dashNextId.textContent = "-";
    if (dashPendingUsdt) dashPendingUsdt.textContent = "-";
    if (dashPendingHex) dashPendingHex.textContent = "-";
    if (dashUpdated) dashUpdated.textContent = nowLabel();
    return;
  }

  const hexDec  = await readDecimalsSafe(rp, HEX_ADDRESS,  window.CONFIG?.TOKENS?.HEX?.decimals ?? 18);
  const usdtDec = await readDecimalsSafe(rp, USDT_ADDRESS, window.CONFIG?.TOKENS?.USDT?.decimals ?? 6);
  const vetDec  = await readDecimalsSafe(rp, VET_ADDRESS,  window.CONFIG?.TOKENS?.VET?.decimals ?? 0);

  const [cxHexBal, cxUsdtBal, cxVetBal] = await Promise.all([
    readBalanceSafe(rp, HEX_ADDRESS, vetEx),
    readBalanceSafe(rp, USDT_ADDRESS, vetEx),
    readBalanceSafe(rp, VET_ADDRESS, vetEx),
  ]);

  if (dashCxHex) { dashCxHex.textContent = fmtUnitsSafe(cxHexBal, hexDec, 4); markOnchain(dashCxHex); }
  if (dashCxUsdt) { dashCxUsdt.textContent = fmtUnitsSafe(cxUsdtBal, usdtDec, 2); markOnchain(dashCxUsdt); }
  if (dashCxVet) { dashCxVet.textContent = fmtUnitsSafe(cxVetBal, vetDec, 4); markOnchain(dashCxVet); }

  let nextId = null;
  let pendingUsdt = null;
  let pendingHex = null;

  try {
    const ex = new ethers.Contract(vetEx, VETEX_READ_ABI, rp);
    const [nid, pusdt, phex] = await Promise.all([
      ex.nextTradeId(),
      ex.pendingUsdtFee(),
      ex.pendingHexFee(),
    ]);
    nextId = nid;
    pendingUsdt = pusdt;
    pendingHex = phex;
  } catch {
    nextId = null;
    pendingUsdt = null;
    pendingHex = null;
  }

  const nid = Number(nextId ?? 0);
  const tradeCount = Number.isFinite(nid) && nid > 0 ? nid - 1 : 0;

  if (dashNextId) { dashNextId.textContent = String(Number.isFinite(nid) ? nid : "-"); markOnchain(dashNextId); }
  if (dashTrades) { dashTrades.textContent = tradeCount.toLocaleString(); markOnchain(dashTrades); }

  // pending fees 표시 (USDT 6, HEX 18)
  if (dashPendingUsdt) { dashPendingUsdt.textContent = fmtUnitsSafe(pendingUsdt ?? 0n, 6, 2); markOnchain(dashPendingUsdt); }
  if (dashPendingHex) { dashPendingHex.textContent = fmtUnitsSafe(pendingHex ?? 0n, 18, 4); markOnchain(dashPendingHex); }

  if (dashUpdated) dashUpdated.textContent = nowLabel();
}

async function ensureChainOpBNB() {
  const want = Number(window.CONFIG?.CHAIN_ID ?? 204);
  const wantHex = "0x" + want.toString(16);

  try {
    const current = await window.ethereum.request({ method: "eth_chainId" });
    if (current && current.toLowerCase() === wantHex.toLowerCase()) return true;
  } catch {}

  try {
    await window.ethereum.request({
      method: "wallet_switchEthereumChain",
      params: [{ chainId: wantHex }],
    });
    return true;
  } catch (e) {
    if (e?.code === 4902) {
      try {
        await window.ethereum.request({
          method: "wallet_addEthereumChain",
          params: [
            {
              chainId: wantHex,
              chainName: "opBNB Mainnet",
              nativeCurrency: { name: "BNB", symbol: "BNB", decimals: 18 },
              rpcUrls: [window.CONFIG?.RPC_URL || "https://opbnb-mainnet-rpc.bnbchain.org"],
              blockExplorerUrls: ["https://opbnbscan.com"],
            },
          ],
        });
        return true;
      } catch {
        return false;
      }
    }
    return false;
  }
}

async function connectWallet() {
  try {
    if (!window.ethereum) return alert("MetaMask/Rabby가 설치되어 있지 않습니다.");
    if (!ethers) return alert("ethers 로드가 안되었습니다. ethers.umd.min.js 로드를 확인하세요.");

    const ok = await ensureChainOpBNB();
    if (!ok) {
      note("opBNB 네트워크로 전환이 필요합니다.", "bad");
      return;
    }

    provider = new ethers.BrowserProvider(window.ethereum);
    await provider.send("eth_requestAccounts", []);

    const s = await provider.getSigner();
    userAddress = await s.getAddress();

    setConnectLabel(true);
    setAddr(userAddress);
    note("지갑 연결됨: " + shortAddr(userAddress), "ok");

    await loadWalletBalances();

    const { dash } = els();
    if (dash && dash.classList.contains("open")) {
      await loadContractDashboard();
    }
  } catch (e) {
    console.error("[wallet] connect error:", e);
    note(e?.message || "지갑 연결 실패", "bad");
    alert(e?.message || "지갑 연결 실패");
  }
}

/* UI 토글 */
function bindHeaderUiOnce() {
  if (boundUi) return;

  const { burger, menu, dashBtn, dash, dashClose } = els();
  if (!burger || !menu || !dashBtn || !dash) return;

  const closeMenu = () => { menu.classList.remove("open"); burger.setAttribute("aria-expanded","false"); };
  burger.addEventListener("click", (e) => {
    e.stopPropagation();
    menu.classList.toggle("open");
    burger.setAttribute("aria-expanded", menu.classList.contains("open") ? "true" : "false");
  });
  menu.addEventListener("click", (e) => {
    const a = e.target && e.target.closest && e.target.closest("a");
    if (a) closeMenu();
  });
  document.addEventListener("click", () => closeMenu());
  document.addEventListener("keydown", (e) => { if (e.key === "Escape") closeMenu(); });

  const openDash = () => {
    dash.classList.add("open");
    dashBtn.setAttribute("aria-expanded","true");
    loadContractDashboard().catch(() => {});
    if (userAddress && provider) loadWalletBalances().catch(() => {});
  };
  const closeDash = () => {
    dash.classList.remove("open");
    dashBtn.setAttribute("aria-expanded","false");
  };

  dashBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    if (dash.classList.contains("open")) closeDash();
    else openDash();
  });

  if (dashClose) dashClose.addEventListener("click", () => closeDash());
  document.addEventListener("keydown", (e) => { if (e.key === "Escape") closeDash(); });

  boundUi = true;
}

function bindWalletOnce() {
  const { btnHeaderConnect, btnPageConnect } = els();
  if (!btnHeaderConnect && !btnPageConnect) return false;

  if (btnHeaderConnect && !btnHeaderConnect.__bound) {
    btnHeaderConnect.addEventListener("click", connectWallet);
    btnHeaderConnect.__bound = true;
  }
  if (btnPageConnect && !btnPageConnect.__bound) {
    btnPageConnect.addEventListener("click", connectWallet);
    btnPageConnect.__bound = true;
  }

  if (!boundWallet && window.ethereum?.on) {
    window.ethereum.on("accountsChanged", async (accs) => {
      userAddress = accs?.[0] || null;
      setAddr(userAddress);

      if (userAddress) {
        setConnectLabel(true);
        provider = new ethers.BrowserProvider(window.ethereum);
        readProvider = null;
        await loadWalletBalances();
      } else {
        setConnectLabel(false);
        setBalances({ hexStr: "-", usdtStr: "-", vetStr: "-" });
      }
    });

    window.ethereum.on("chainChanged", () => {
      provider = new ethers.BrowserProvider(window.ethereum);
      readProvider = null;
      loadContractDashboard().catch(() => {});
      if (userAddress) loadWalletBalances().catch(() => {});
    });

    boundWallet = true;
  }

  return true;
}

function startWatcher() {
  let tries = 0;
  const t = setInterval(() => {
    bindHeaderUiOnce();
    const ok = bindWalletOnce();
    tries += 1;
    if ((boundUi && ok) || tries > 200) clearInterval(t);
  }, 50);
}

// 부팅
startWatcher();

// 지갑 연결 없어도 계약 정보는 미리 표시(대시보드 열면 즉시 보여야 해서)
setTimeout(() => { loadContractDashboard().catch(() => {}); }, 300);

// 디버그
window.__hdrWallet = {
  connect: connectWallet,
  reload: () => Promise.allSettled([loadWalletBalances(), loadContractDashboard()]),
};
