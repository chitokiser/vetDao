// /assets/js/pages/sell.js
import {
  doc,
  getDoc,
  setDoc,
  serverTimestamp,
} from "https://www.gstatic.com/firebasejs/10.7.0/firebase-firestore.js";

const ethers = window.ethers;
const CONFIG = window.CONFIG;
const ABI = window.ABI;
const db = window.db;

const $ = (id) => document.getElementById(id);

const ERC20_ABI = [
  "function allowance(address owner,address spender) view returns (uint256)",
  "function approve(address spender,uint256 value) returns (bool)",
  "function decimals() view returns (uint8)",
];

let provider, signer, account;

function dbg(msg) {
  const p = $("dbg");
  if (p) p.textContent += msg + "\n";
  console.log(msg);
}

function setNote(msg, type = "") {
  const el = $("note");
  if (!el) return;
  el.className = "note" + (type ? " " + type : "");
  el.style.display = msg ? "block" : "none";
  el.innerHTML = msg || "";
  dbg("note: " + (msg || ""));
}

function shortAddr(a) {
  return a ? a.slice(0, 6) + "..." + a.slice(-4) : "-";
}

function fiatEnum(fiat) {
  return fiat === "KRW" ? 0 : 1;
}

// 컨트랙트별 컬렉션 분리: trades_{vetEX주소}
function tradesCollectionName() {
  const addr = (CONFIG?.CONTRACT?.vetEX || "").toLowerCase();
  if (!addr) return "trades";
  return "trades_" + addr;
}

function updateTotal() {
  const a = Number($("amount")?.value || 0);
  const p = Number($("unitPrice")?.value || 0);
  const fiat = $("fiat")?.value || "KRW";
  const out = $("totalFiat");
  if (!out) return;

  if (!a || !p) {
    out.textContent = "-";
    return;
  }
  out.textContent = (a * p).toLocaleString() + " " + fiat;
  out.classList.add("onchain");
}

async function connectWallet() {
  if (!ethers) throw new Error("ethers(UMD) 로드가 안됨");
  if (!window.ethereum) throw new Error("MetaMask/Rabby 설치 필요");

  provider = new ethers.BrowserProvider(window.ethereum);
  await provider.send("eth_requestAccounts", []);
  signer = await provider.getSigner();
  account = await signer.getAddress();

  const wl = $("walletLine");
  if (wl) {
    wl.textContent = shortAddr(account);
    wl.classList.add("onchain");
  }

  dbg("wallet connected: " + account);
  return account;
}

async function getContract() {
  if (!CONFIG?.CONTRACT?.vetEX) throw new Error("CONFIG.CONTRACT.vetEX 없음 (config.js 확인)");
  if (!ABI?.length) throw new Error("window.ABI 없음 (contract.js 확인)");
  if (!signer) throw new Error("지갑 미연결");
  return new ethers.Contract(CONFIG.CONTRACT.vetEX, ABI, signer);
}

// Firestore users/{wallet} 에 kakaoId 또는 telegramId 있으면 통과
async function ensureSellerProfileOrStop() {
  if (!db) {
    setNote("Firestore 초기화(window.db) 실패", "bad");
    return false;
  }
  if (!account) {
    setNote("지갑을 먼저 연결하세요.", "bad");
    return false;
  }

  try {
    const ref = doc(db, "users", account.toLowerCase());
    const snap = await getDoc(ref);

    if (!snap.exists()) {
      setNote(
        `판매등록 전에 프로필에서 SNS(카카오/텔레그램 등) 최소 1개 등록이 필요합니다. (파이어베이스)
         <span style="display:inline-block;width:10px;"></span>
         <a class="btn" href="/profile.html" style="padding:6px 10px; font-size:12px;">프로필로 가기</a>`,
        "bad"
      );
      return false;
    }

    const d = snap.data() || {};
    const kakao = String(d.kakaoId || "").trim();
    const tele = String(d.telegramId || "").trim();

    if (!kakao && !tele) {
      setNote(
        `판매등록 전에 프로필에서 SNS(카카오/텔레그램 등) 최소 1개 등록이 필요합니다. (파이어베이스)
         <span style="display:inline-block;width:10px;"></span>
         <a class="btn" href="/profile.html" style="padding:6px 10px; font-size:12px;">프로필로 가기</a>`,
        "bad"
      );
      return false;
    }

    return true;
  } catch (e) {
    console.error(e);
    setNote(
      `프로필(SNS) 확인에 실패했습니다. 프로필에서 SNS 저장 후 다시 시도하세요.
       <span style="display:inline-block;width:10px;"></span>
       <a class="btn" href="/profile.html" style="padding:6px 10px; font-size:12px;">프로필로 가기</a>`,
      "bad"
    );
    return false;
  }
}

async function ensureAllowance(tokenAddr, amountWei) {
  const token = new ethers.Contract(tokenAddr, ERC20_ABI, signer);
  const cur = await token.allowance(account, CONFIG.CONTRACT.vetEX);
  if (cur >= amountWei) return;

  setNote("토큰 승인(approve) 진행 중...", "");
  const tx = await token.approve(CONFIG.CONTRACT.vetEX, amountWei);
  await tx.wait();
}

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

async function onSubmit() {
  try {
    setNote("");

    if (!db) return setNote("Firestore 초기화(window.db) 실패", "bad");

    // 익명 auth를 rules에서 쓰려면 여기서 대기 (firebase.js에서 window.authReady 제공 시)
    if (window.authReady) await window.authReady;

    if (!account) await connectWallet();

    const ok = await ensureSellerProfileOrStop();
    if (!ok) return;

    const tokenKey = ($("token")?.value || "").trim();
    const fiat = ($("fiat")?.value || "").trim();
    const amountText = ($("amount")?.value || "").trim();
    const unitPriceText = ($("unitPrice")?.value || "").trim();

    if (!tokenKey) return setNote("토큰을 선택하세요.", "bad");
    if (!fiat) return setNote("결제통화를 선택하세요.", "bad");
    if (!amountText || Number(amountText) <= 0) return setNote("판매 수량을 입력하세요.", "bad");
    if (!unitPriceText || Number(unitPriceText) <= 0) return setNote("개당 가격을 입력하세요.", "bad");

    const tokenCfg = CONFIG?.TOKENS?.[tokenKey];
    if (!tokenCfg?.address) return setNote("config.js TOKENS 설정이 비었습니다.", "bad");

    const amountWei = ethers.parseUnits(amountText, tokenCfg.decimals ?? 18);
    const fiatAmount = Math.floor(Number(amountText) * Number(unitPriceText));

    const c = await getContract();

    await ensureAllowance(tokenCfg.address, amountWei);

    setNote("트랜잭션 전송 중...", "");
    const tx = await c.openTrade(
      tokenCfg.address,
      amountWei,
      ethers.ZeroAddress,
      fiatEnum(fiat),
      fiatAmount,
      ethers.ZeroHash
    );

    const receipt = await tx.wait();
    const tradeId = parseTradeId(receipt);
    if (!tradeId) return setNote("등록은 됐지만 tradeId를 못 찾았습니다. ABI/이벤트 확인 필요", "bad");

    // Firestore write (컨트랙트별 컬렉션)
    const col = tradesCollectionName();
    dbg("firestore write => " + col + "/" + String(tradeId));

    setNote("파이어베이스 저장 중...", "");
    await setDoc(
      doc(db, col, String(tradeId)),
      {
        tradeId,
        seller: account,
        tokenSymbol: tokenKey,
        fiat,
        amount: Number(amountText),
        unitPrice: Number(unitPriceText),
        fiatAmount, // index에서 판매금액을 더 안정적으로 표시
        contract: (CONFIG.CONTRACT.vetEX || "").toLowerCase(),
        txHash: receipt.hash,
        blockNumber: receipt.blockNumber,
        status: 0, // OPEN로 시작 (체인과 동일)
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      },
      { merge: true }
    );

    setNote(`판매 등록 완료. tradeId=${tradeId}`, "ok");
  } catch (e) {
    console.error(e);

    const code = e?.code ? `(${e.code}) ` : "";
    const msg =
      code +
      (e?.shortMessage ||
        e?.info?.error?.message ||
        e?.reason ||
        e?.message ||
        String(e));

    setNote(msg, "bad");
  }
}

function bind() {
  $("btnConnect")?.addEventListener("click", async () => {
    try {
      setNote("");
      if (window.authReady) await window.authReady;
      await connectWallet();
      setNote("지갑 연결됨", "ok");
    } catch (e) {
      setNote(e?.message || String(e), "bad");
    }
  });

  $("btnSubmit")?.addEventListener("click", onSubmit);

  $("amount")?.addEventListener("input", updateTotal);
  $("unitPrice")?.addEventListener("input", updateTotal);
  $("fiat")?.addEventListener("change", updateTotal);

  updateTotal();
  dbg("sell.js bind done");
}

dbg("sell.js loaded");
bind();
