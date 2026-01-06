import { ethers } from "https://cdn.jsdelivr.net/npm/ethers@6.14.0/dist/ethers.min.js";
import { CONFIG } from "/assets/js/config.js";
import { ABI } from "/assets/js/contract.js";
import { db } from "/assets/js/firebase.js";
import {
  doc,
  getDoc,
} from "https://www.gstatic.com/firebasejs/10.7.0/firebase-firestore.js";

const $ = (id) => document.getElementById(id);

// ----------------------------
// 상태/유틸
// ----------------------------
let provider;
let signer;
let account;

const ERC20_ABI = [
  "function balanceOf(address) view returns (uint256)",
  "function decimals() view returns (uint8)",
];

function showNote(msg, type = "") {
  const el = $("note");
  if (!el) return;
  el.style.display = msg ? "block" : "none";
  el.className = "note" + (type ? " " + type : "");
  el.textContent = msg || "";
}

function shortAddr(a) {
  if (!a) return "-";
  return a.slice(0, 6) + "..." + a.slice(-4);
}

function fiatLabel(v) {
  return Number(v) === 0 ? "KRW" : "VND";
}

function statusLabel(v) {
  const n = Number(v);
  // Status: 0=OPEN,1=TAKEN,2=PAID,3=RELEASED,4=CANCELED,5=DISPUTED,6=RESOLVED
  return ["OPEN", "TAKEN", "PAID", "RELEASED", "CANCELED", "DISPUTED", "RESOLVED"][n] ?? String(n);
}

function tokenSymbolByAddr(addr) {
  const a = (addr || "").toLowerCase();
  const hex = CONFIG.TOKENS?.HEX?.address?.toLowerCase();
  const usdt = CONFIG.TOKENS?.USDT?.address?.toLowerCase();
  if (hex && a === hex) return "HEX";
  if (usdt && a === usdt) return "USDT";
  return addr;
}

async function getVetEx(readOnly = true) {
  const p = provider ?? new ethers.JsonRpcProvider(CONFIG.RPC_URL);
  const s = signer ?? null;
  return new ethers.Contract(CONFIG.CONTRACT.vetEX, ABI, readOnly ? p : s);
}

async function getErc20(addr) {
  return new ethers.Contract(addr, ERC20_ABI, provider);
}

async function readBalance(tokenAddr, ownerAddr, fallbackDecimals = 18) {
  const t = await getErc20(tokenAddr);
  let d = fallbackDecimals;
  try { d = Number(await t.decimals()); } catch {}
  const b = await t.balanceOf(ownerAddr);
  return { b, d };
}

async function refreshHeaderBalances() {
  if (!account) return;

  $("walletAddr").textContent = shortAddr(account);

  try {
    const hexAddr = CONFIG.TOKENS?.HEX?.address;
    const usdtAddr = CONFIG.TOKENS?.USDT?.address;

    if (hexAddr) {
      const { b, d } = await readBalance(hexAddr, account, CONFIG.TOKENS?.HEX?.decimals ?? 18);
      $("myHexBal").textContent = ethers.formatUnits(b, d);
    } else {
      $("myHexBal").textContent = "no HEX addr";
    }

    if (usdtAddr) {
      const { b, d } = await readBalance(usdtAddr, account, CONFIG.TOKENS?.USDT?.decimals ?? 18);
      $("myUsdtBal").textContent = ethers.formatUnits(b, d);
    } else {
      $("myUsdtBal").textContent = "no USDT addr";
    }
  } catch (e) {
    console.error(e);
    showNote("잔고 조회 실패 (RPC/토큰주소/네트워크 확인)", "bad");
  }
}

async function connectWallet() {
  if (!window.ethereum) {
    showNote("지갑이 없습니다. MetaMask/Rabby 설치 필요", "bad");
    return null;
  }
  provider = new ethers.BrowserProvider(window.ethereum);
  await provider.send("eth_requestAccounts", []);
  signer = await provider.getSigner();
  account = await signer.getAddress();
  await refreshHeaderBalances();
  showNote("지갑 연결됨: " + shortAddr(account), "ok");
  return account;
}

// ----------------------------
// tradeId 파싱
// ----------------------------
function getTradeIdFromQuery() {
  const u = new URL(location.href);
  const id = u.searchParams.get("id");
  if (!id) return null;
  // Firestore 문서키를 tradeId 숫자로 쓰는 구조
  return id;
}

// ----------------------------
// Firestore + Onchain 로드
// ----------------------------
async function loadTrade(tradeId) {
  $("subTitle").textContent = `tradeId = ${tradeId}`;

  // 1) Firestore 문서(리스트 표시에 필요한 메타: sns, unitPrice 등)
  let meta = null;
  try {
    const ref = doc(db, "trades", String(tradeId));
    const snap = await getDoc(ref);
    if (snap.exists()) meta = snap.data();
  } catch (e) {
    console.warn("firestore meta load fail:", e);
  }

  // 2) 온체인 trade struct
  const c = await getVetEx(true);

  let on;
  try {
    on = await c.trades(tradeId);
  } catch (e) {
    console.error(e);
    showNote("온체인 trade 조회 실패: 컨트랙트 주소/ABI/tradeId 확인", "bad");
    return;
  }

  // on = (seller, buyer, token, amount, fiat, fiatAmount, paymentRef, createdAt, paidAt, status) 형태일 가능성이 큼
  // 지금 pasted 기준으로 trades는 struct getter라 튜플로 옵니다.:contentReference[oaicite:0]{index=0}:contentReference[oaicite:1]{index=1}
  const seller = on.seller ?? on[0];
  const buyer = on.buyer ?? on[1];
  const token = on.token ?? on[2];
  const amount = on.amount ?? on[3];
  const fiat = on.fiat ?? on[4];
  const fiatAmount = on.fiatAmount ?? on[5];
  const paymentRef = on.paymentRef ?? on[6];
  const status = on.status ?? on[9] ?? on[8]; // 컴파일 버전/구조에 따라 인덱스가 다를 수 있어 안전 처리

  const sym = tokenSymbolByAddr(token);

  // decimals
  const dec =
    sym === "HEX" ? (CONFIG.TOKENS?.HEX?.decimals ?? 18)
    : sym === "USDT" ? (CONFIG.TOKENS?.USDT?.decimals ?? 18)
    : 18;

  $("vToken").textContent = sym;
  $("vAmount").textContent = ethers.formatUnits(amount, dec);
  $("vFiat").textContent = fiatLabel(fiat);
  $("vFiatAmount").textContent = Number(fiatAmount ?? 0).toLocaleString();
  $("vStatus").textContent = statusLabel(status ?? 0);
  $("vPaymentRef").textContent = paymentRef && paymentRef !== ethers.ZeroHash ? String(paymentRef) : "-";
  $("vSeller").textContent = seller;
  $("vBuyer").textContent = buyer && buyer !== ethers.ZeroAddress ? buyer : "-";

  // seller SNS 표시 (우선 Firestore meta.sellerSns 우선, 없으면 onchain에서 getSellerContact로 조회)
  let sellerSns = meta?.sellerSns || "-";
  try {
    const [kakaoId, telegramId, registered] = await c.getSellerContact(seller);
    if (registered) {
      const kk = kakaoId ? `kakao: ${kakaoId}` : "";
      const tg = telegramId ? `tg: ${telegramId}` : "";
      const join = [kk, tg].filter(Boolean).join(" / ");
      sellerSns = join || sellerSns;
    }
  } catch {
    // ABI에 getSellerContact가 없으면 여기서 실패할 수 있음
  }
  $("vSellerSns").textContent = sellerSns;

  // VET 보상 뱃지
  $("vVetBadge").innerHTML = (sym === "HEX")
    ? `<span class="badge">매수자에게 VET 보상</span>`
    : `-`;

  // 버튼 권한 안내
  // (실제 권한 체크는 컨트랙트가 revert로 막습니다)
}

// ----------------------------
// 액션(accept/paid/release/cancel)
// ----------------------------
async function doAccept(tradeId) {
  showNote("");
  if (!account) await connectWallet();
  const c = await getVetEx(false);

  try {
    showNote("acceptTrade 트랜잭션 전송...", "");
    const tx = await c.acceptTrade(tradeId);
    await tx.wait();
    showNote("acceptTrade 완료", "ok");
  } catch (e) {
    console.error(e);
    showNote(e?.shortMessage || e?.message || String(e), "bad");
  }
}

function toRefHash(str) {
  if (!str) return ethers.ZeroHash;
  return ethers.keccak256(ethers.toUtf8Bytes(str));
}

async function doPaid(tradeId) {
  showNote("");
  if (!account) await connectWallet();
  const c = await getVetEx(false);

  try {
    const raw = $("inpRef").value.trim();
    const ref = toRefHash(raw);

    showNote("markPaid 트랜잭션 전송...", "");
    const tx = await c.markPaid(tradeId, ref);
    await tx.wait();
    showNote("markPaid 완료", "ok");
  } catch (e) {
    console.error(e);
    showNote(e?.shortMessage || e?.message || String(e), "bad");
  }
}

async function doRelease(tradeId) {
  showNote("");
  if (!account) await connectWallet();
  const c = await getVetEx(false);

  try {
    showNote("release 트랜잭션 전송...", "");
    const tx = await c.release(tradeId);
    await tx.wait();
    showNote("release 완료 (구매자에게 토큰 전송됨)", "ok");
  } catch (e) {
    console.error(e);
    showNote(e?.shortMessage || e?.message || String(e), "bad");
  }
}

async function doCancel(tradeId) {
  showNote("");
  if (!account) await connectWallet();
  const c = await getVetEx(false);

  try {
    showNote("cancelBySeller 트랜잭션 전송...", "");
    const tx = await c.cancelBySeller(tradeId);
    await tx.wait();
    showNote("취소 완료 (판매자에게 토큰 반환)", "ok");
  } catch (e) {
    console.error(e);
    showNote(e?.shortMessage || e?.message || String(e), "bad");
  }
}

// ----------------------------
// boot
// ----------------------------
(async function boot() {
  try {
    const tradeId = getTradeIdFromQuery();
    if (!tradeId) {
      showNote("trade.html?id=숫자 형식으로 접근하세요.", "bad");
      return;
    }

    // 이벤트만으로도 진행은 “가능”하지만, 리스트/상세를 안정적으로 하려면
    // Firestore에 tradeId/메타를 저장하고, 상세에서 온체인 상태를 확인하는 구성이 좋습니다.
    // (RPC getLogs 범위 제한 때문에 전체 이벤트 스캔은 자주 막힘)

    await loadTrade(tradeId);

    $("btnConnect").addEventListener("click", connectWallet);
    $("btnAccept").addEventListener("click", () => doAccept(tradeId));
    $("btnPaid").addEventListener("click", () => doPaid(tradeId));
    $("btnRelease").addEventListener("click", () => doRelease(tradeId));
    $("btnCancel").addEventListener("click", () => doCancel(tradeId));
  } catch (e) {
    console.error(e);
    showNote(e?.message || String(e), "bad");
  }
})();
