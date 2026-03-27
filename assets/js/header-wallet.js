// /assets/js/header-wallet.js
// ethers는 UMD 전역(window.ethers) 사용
const ethers = window.ethers;

const HEX_ADDRESS  = "0x41F2Ea9F4eF7c4E35ba1a8438fC80937eD4E5464";
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
    btnHeaderConnect: document.getElementById("hdrConnect"),
    btnPageConnect:   document.getElementById("btnConnect"),

    boxHeaderBalances: document.getElementById("hdrBalances"),
    elHeaderAddr: document.getElementById("hdrAddr"),
    elHeaderHex:  document.getElementById("hdrHex"),
    elHeaderVet:  document.getElementById("hdrVet"),

    elPageAddr: document.getElementById("walletAddr"),
    elPageHex:  document.getElementById("myHexBal"),
    elPageVet:  document.getElementById("myVetBal"),

    burger: document.getElementById("hdrBurger"),
    menu:   document.getElementById("hdrMenu"),

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
  // Jump 활성 중이면 MetaMask 버튼에 비활성 표시
  const label = window.jumpWallet ? "지갑 연결" : (connected ? "연결됨" : "지갑 연결");
  if (btnHeaderConnect) btnHeaderConnect.textContent = label;
  if (btnPageConnect) btnPageConnect.textContent = label;
}

function setAddr(addr) {
  const { elHeaderAddr, elPageAddr, dashAddr } = els();
  const s = shortAddr(addr);
  // 활성 지갑 타입 표시: 📧=수탁, 🦊=MetaMask
  const tag = window.jumpWallet ? "📧 " : (addr ? "🦊 " : "");
  const display = addr ? (tag + s) : "미연결";

  if (elHeaderAddr) { elHeaderAddr.textContent = display; markOnchain(elHeaderAddr); }
  if (elPageAddr) { elPageAddr.textContent = display; markOnchain(elPageAddr); }
  if (dashAddr) dashAddr.textContent = display;
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

function setBalances({ hexStr, vetStr }) {
  const { elHeaderHex, elHeaderVet, elPageHex, elPageVet, boxHeaderBalances } = els();

  if (elHeaderHex) { elHeaderHex.textContent = hexStr; markOnchain(elHeaderHex); }
  if (elHeaderVet) { elHeaderVet.textContent = vetStr; markOnchain(elHeaderVet); }
  if (elPageHex)   { elPageHex.textContent   = hexStr; markOnchain(elPageHex); }
  if (elPageVet)   { elPageVet.textContent   = vetStr; markOnchain(elPageVet); }
  if (boxHeaderBalances) boxHeaderBalances.style.display = "inline-flex";
}

async function loadWalletBalances() {
  if (!userAddress) return;
  // Jump 수탁지갑은 provider(BrowserProvider)가 없고 readProvider(JsonRpcProvider)만 있음
  const rp = ensureReadProvider() || provider;
  if (!rp) return;

  const hexDec = await readDecimalsSafe(rp, HEX_ADDRESS, window.CONFIG?.TOKENS?.HEX?.decimals ?? 18);
  const vetDec = await readDecimalsSafe(rp, VET_ADDRESS, window.CONFIG?.TOKENS?.VET?.decimals ?? 0);

  const [hexBal, vetBal] = await Promise.all([
    readBalanceSafe(rp, HEX_ADDRESS, userAddress),
    readBalanceSafe(rp, VET_ADDRESS, userAddress),
  ]);

  setBalances({
    hexStr: fmtUnitsSafe(hexBal, hexDec, 4),
    vetStr: fmtUnitsSafe(vetBal, vetDec, 4),
  });
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

// ── Jump 수탁지갑 관련 ────────────────────────────────────────────────────

function loadScript(src) {
  return new Promise((resolve, reject) => {
    if (document.querySelector(`script[src="${src}"]`)) { resolve(); return; }
    const s = document.createElement('script');
    s.src = src;
    s.onload = resolve;
    s.onerror = () => reject(new Error('스크립트 로드 실패: ' + src));
    document.head.appendChild(s);
  });
}

async function loadFirebaseAndJump() {
  const FBV = '9.23.0';
  await loadScript(`https://www.gstatic.com/firebasejs/${FBV}/firebase-app-compat.js`);
  await loadScript(`https://www.gstatic.com/firebasejs/${FBV}/firebase-auth-compat.js`);
  await loadScript('/assets/js/jump-auth.js');
}

async function onJumpConnected(wallet) {
  const rp = new ethers.JsonRpcProvider(window.CONFIG?.RPC_URL || 'https://opbnb-mainnet-rpc.bnbchain.org');
  window.__jumpProvider = rp;
  readProvider = rp;
  provider = null;   // MetaMask BrowserProvider 제거
  userAddress = wallet.address;

  // MetaMask 버튼은 "지갑 연결" 상태로 (Jump가 active이므로 비활성 표시)
  const { btnHeaderConnect, btnPageConnect } = els();
  if (btnHeaderConnect) btnHeaderConnect.textContent = "지갑 연결";
  if (btnPageConnect) btnPageConnect.textContent = "지갑 연결";

  setAddr(userAddress);
  note('구글(수탁) 지갑 연결됨: 📧 ' + shortAddr(userAddress), 'ok');

  await loadWalletBalances();
  startHeartbeat(userAddress);

  const gBtn = document.getElementById('btnGoogleLogin');
  if (gBtn) {
    gBtn.innerHTML = `<span style="font-size:12px;">📧</span> ${wallet.email.split('@')[0]}`;
  }

  // 관리자 메뉴 표시 (daguru75@gmail.com만)
  const isAdmin = wallet.email === 'daguru75@gmail.com';
  const navAdmin       = document.getElementById('navAdmin');
  const navAdminMobile = document.getElementById('navAdminMobile');
  if (navAdmin)       navAdmin.style.display       = isAdmin ? '' : 'none';
  if (navAdminMobile) navAdminMobile.style.display = isAdmin ? '' : 'none';

  window.dispatchEvent(new CustomEvent('jump:connected', { detail: wallet }));
  notifyWalletConnected(wallet.address, 'jump');
}

let _jumpConnecting = false;
async function connectJump() {
  if (window.jumpWallet) {
    if (confirm(`${window.jumpWallet.email} 로그아웃 하시겠습니까?`)) {
      await window.jumpLogout();
    }
    return;
  }

  // Jump 수탁지갑 소유자 안내
  note(
    '💡 구글 로그인은 Jump 수탁지갑 소유자 전용입니다. ' +
    '수탁지갑이 없으시면 MetaMask/Rabby(지갑 연결)를 이용하세요.',
    ''
  );

  // MetaMask가 이미 연결된 경우 전환 확인
  if (userAddress && provider) {
    const ok = confirm(
      `현재 MetaMask 지갑(${shortAddr(userAddress)})이 연결되어 있습니다.\n` +
      `구글 수탁지갑으로 전환하면 MetaMask는 비활성화됩니다.\n계속하시겠습니까?`
    );
    if (!ok) return;
    // MetaMask 상태 초기화 (이벤트 리스너는 jumpWallet 가드로 차단됨)
    provider = null;
    const prevAddr = userAddress;
    userAddress = null;
    setConnectLabel(false);
    setAddr(null);
    note(`MetaMask(${shortAddr(prevAddr)}) 비활성화 → 구글 수탁지갑으로 전환`, "");
  }

  if (_jumpConnecting) return;
  _jumpConnecting = true;
  const gBtn = document.getElementById('btnGoogleLogin');
  if (gBtn) gBtn.textContent = '연결 중...';
  try {
    await loadFirebaseAndJump();
    const wallet = await window.jumpLogin();
    if (!wallet) return;
    await onJumpConnected(wallet);
  } catch (e) {
    console.error('Jump 로그인 실패', e);
    if (gBtn) gBtn.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" style="flex-shrink:0;"><path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"/><path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"/><path fill="#FBBC05" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"/><path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"/></svg> 구글 로그인`;
    if (e?.code !== 'auth/popup-closed-by-user') {
      note(e?.message || 'Jump 로그인 실패', 'bad');
    }
  } finally {
    _jumpConnecting = false;
  }
}

// ── MetaMask 연결 ─────────────────────────────────────────────────────────

// ── 통합 연결 알림 ───────────────────────────────────────────────────────────
// 지갑이 연결/복원될 때 항상 이 함수를 통해 알림 → 모든 페이지가 wallet:connected 이벤트로 수신
function notifyWalletConnected(addr, type) {
  if (!addr) return;
  window.__hdrWallet._address = addr.toLowerCase();
  window.dispatchEvent(new CustomEvent('wallet:connected', {
    detail: { address: addr, type: type || 'metamask' }
  }));
}

async function connectWallet() {
  if (window.jumpWallet) {
    note(`구글 수탁지갑(${shortAddr(window.jumpWallet.address)})이 활성 상태입니다. 먼저 구글 로그아웃 후 MetaMask를 연결하세요.`, "bad");
    return;
  }
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
    startHeartbeat(userAddress);
    notifyWalletConnected(userAddress, 'metamask');
  } catch (e) {
    console.error("[wallet] connect error:", e);
    note(e?.message || "지갑 연결 실패", "bad");
    alert(e?.message || "지갑 연결 실패");
  }
}

// ── MetaMask 세션 자동 복원 ──────────────────────────────────────────────────
// 이전 페이지에서 MetaMask를 연결했다면 eth_accounts(팝업 없음)로 주소 복원
async function tryAutoRestoreMetaMask() {
  if (window.jumpWallet) return; // Jump 우선
  if (!window.ethereum || !ethers) return;
  try {
    const accs = await window.ethereum.request({ method: 'eth_accounts' });
    if (!accs?.length) return;
    provider    = new ethers.BrowserProvider(window.ethereum);
    userAddress = accs[0];
    setConnectLabel(true);
    setAddr(userAddress);
    await loadWalletBalances();
    startHeartbeat(userAddress);
    notifyWalletConnected(userAddress, 'metamask');
  } catch (e) {
    console.warn('[wallet] MetaMask 복원 실패:', e);
  }
}

function bindHeaderUiOnce() {
  if (boundUi) return;

  const { burger, menu } = els();
  if (!burger || !menu) return;

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

  boundUi = true;
}

function bindWalletOnce() {
  // 헤더 버튼(hdrConnect)만 바인딩.
  // 페이지 버튼(btnConnect)은 각 페이지 스크립트(sell.js, trade.js)가 직접 관리함.
  const { btnHeaderConnect } = els();
  if (!btnHeaderConnect) return false;

  if (!btnHeaderConnect.__bound) {
    btnHeaderConnect.addEventListener("click", connectWallet);
    btnHeaderConnect.__bound = true;
  }

  const gBtn = document.getElementById("btnGoogleLogin");
  if (gBtn && !gBtn.__bound) {
    gBtn.addEventListener("click", connectJump);
    gBtn.__bound = true;
  }

  if (!boundWallet && window.ethereum?.on) {
    window.ethereum.on("accountsChanged", async (accs) => {
      // Jump 수탁지갑 활성 중이면 MetaMask 이벤트 무시
      if (window.jumpWallet) return;

      userAddress = accs?.[0] || null;
      setAddr(userAddress);

      if (userAddress) {
        setConnectLabel(true);
        provider = new ethers.BrowserProvider(window.ethereum);
        readProvider = null;
        await loadWalletBalances();
      } else {
        setConnectLabel(false);
        setBalances({ hexStr: "-", vetStr: "-" });
      }
    });

    window.ethereum.on("chainChanged", () => {
      if (window.jumpWallet) return;
      provider = new ethers.BrowserProvider(window.ethereum);
      readProvider = null;
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

// ── 온라인 heartbeat (lastSeen 갱신) ─────────────────────────────────────────
let _heartbeatTimer = null;
async function pingLastSeen(address) {
  if (!window.db || !address) return;
  try {
    const { doc, setDoc, serverTimestamp } =
      await import("https://www.gstatic.com/firebasejs/10.7.0/firebase-firestore.js");
    await setDoc(
      doc(window.db, "users", address.toLowerCase()),
      { lastSeen: serverTimestamp(), online: true },
      { merge: true }
    );
  } catch (e) { console.warn("[heartbeat]", e); }
}

function startHeartbeat(address) {
  if (!address) return;
  pingLastSeen(address);                        // 즉시 1회
  clearInterval(_heartbeatTimer);
  _heartbeatTimer = setInterval(() => pingLastSeen(address), 3 * 60 * 1000); // 3분마다
}

// ── Jump 세션 자동 복원 ───────────────────────────────────────────────────────
// 이전 페이지에서 Google 로그인을 했다면 Firebase Auth가 IndexedDB에 세션을 보존함.
// 페이지 로드 시 Firebase 스크립트를 로드하고 onAuthStateChanged로 복원한다.
async function tryAutoRestoreJump() {
  try {
    await loadFirebaseAndJump();          // Firebase compat SDK + jump-auth.js 로드
    if (!window.jumpAutoRestore) return;
    const wallet = await window.jumpAutoRestore();
    if (wallet) await onJumpConnected(wallet);
  } catch (e) {
    console.warn('[wallet] Jump 세션 복원 실패:', e);
  }
}

// 부팅
startWatcher();

// __hdrWallet 먼저 선언 (페이지 스크립트가 참조할 수 있도록)
window.__hdrWallet = {
  _address: null,
  get address() {
    return this._address || window.jumpWallet?.address?.toLowerCase() || null;
  },
  connect: connectWallet,
  reload:  () => loadWalletBalances(),
};

// Jump 세션 복원 (이전 Google 로그인 유지)
tryAutoRestoreJump();

// MetaMask 세션 복원 (Jump 복원 완료 후 실행)
// Jump가 복원되면 notifyWalletConnected를 먼저 호출하므로 MetaMask는 스킵됨
setTimeout(() => {
  if (!window.__hdrWallet.address) tryAutoRestoreMetaMask();
}, 200);
