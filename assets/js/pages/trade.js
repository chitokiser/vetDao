// /assets/js/pages/trade.js
import { ethers } from "https://cdn.jsdelivr.net/npm/ethers@6.14.0/dist/ethers.min.js";
import { doc, getDoc } from "https://www.gstatic.com/firebasejs/10.7.0/firebase-firestore.js";

const CONFIG = window.CONFIG;
const ABI = window.ABI;
const db = window.db;

const $ = (id) => document.getElementById(id);

// ----------------------------
// 기본 상태
// ----------------------------
let provider;
let signer;
let account;

const VET_EX = CONFIG?.CONTRACT?.vetEX;
const RPC_URL = CONFIG?.RPC_URL;

const HEX_ADDR = CONFIG?.TOKENS?.HEX?.address || CONFIG?.ADDR?.hex || CONFIG?.CONTRACT?.hex;
const USDT_ADDR = CONFIG?.TOKENS?.USDT?.address || CONFIG?.ADDR?.usdt || CONFIG?.CONTRACT?.usdt;

const VET_ADDR =
  CONFIG?.TOKENS?.VET?.address ||
  CONFIG?.ADDR?.vet ||
  CONFIG?.CONTRACT?.vet ||
  "0xff8eCA08F731EAe46b5e7d10eBF640A8Ca7BA3D4";

const ERC20_ABI = [
  "function balanceOf(address) view returns (uint256)",
  "function decimals() view returns (uint8)",
  "function symbol() view returns (string)",
  "function transfer(address,uint256) returns (bool)",
];

const VETEX_ERRORS = [
  "error BadStatus()",
  "error NoTrade()",
  "error NotSeller()",
  "error NotBuyer()",
  "error NotParty()",
  "error TooEarly()",
  "error AlreadyRegistered()",
  "error NotRegistered()",
  "error TokenZero()",
  "error AmountZero()",
  "error FeeTooHigh()",
  "error ParamTooSmall()",
  "error NotArbitrator()",
  "error FlushZero()",
  "error VetBankNotSet()",
  "error UsdtNotSet()",
  "error ZeroAddress()",
  "error Reentrancy()",
  "error NotOwner()",
];

const errorIface = new ethers.Interface(VETEX_ERRORS);

function decodeCustomError(e) {
  const data =
    e?.data ||
    e?.info?.error?.data ||
    e?.error?.data ||
    e?.info?.payload?.params?.[0]?.data ||
    null;

  if (!data || typeof data !== "string") return null;

  try {
    const parsed = errorIface.parseError(data);
    return parsed?.name ? `${parsed.name}()` : null;
  } catch {
    return null;
  }
}

// ----------------------------
// 스타일 주입
// ----------------------------
function injectTradeStyleOnce() {
  if (document.getElementById("__tradeStyle")) return;
  const st = document.createElement("style");
  st.id = "__tradeStyle";
  st.textContent = `
    .btn, button.btn{
      display:inline-flex;
      align-items:center;
      justify-content:center;
      gap:8px;
      line-height:1;
      height:44px;
      padding: 0 16px;
      white-space:nowrap;
      border-radius: 14px;
    }
    .trade-inline{
      display:flex;
      gap:12px;
      align-items:center;
      width:100%;
      max-width:100%;
    }
    .trade-inline .input{ flex:1 1 auto; min-width:0; }
    .trade-inline .btn{ flex:0 0 auto; min-width:120px; }

    .trade-statusbar{
      border: 1px solid rgba(255,255,255,0.12);
      background: linear-gradient(180deg, rgba(255,255,255,0.06), rgba(255,255,255,0.03));
      border-radius: 16px;
      padding: 12px 14px;
      margin: 12px 0 14px 0;
    }
    .trade-statusbar .row{
      display:flex;
      gap:10px;
      align-items:center;
      flex-wrap:wrap;
    }
    .trade-chip{
      display:inline-flex;
      align-items:center;
      justify-content:center;
      height:28px;
      padding: 0 10px;
      border-radius:999px;
      border:1px solid rgba(255,255,255,0.16);
      background: rgba(0,0,0,0.18);
      font-size:12px;
      color: rgba(255,255,255,0.82);
    }
    .trade-chip.ok{ border-color: rgba(34,197,94,0.40); }
    .trade-chip.bad{ border-color: rgba(255,77,109,0.40); }
    .trade-next{
      margin-top:10px;
      font-size:13px;
      color: rgba(255,255,255,0.78);
      line-height:1.5;
      white-space:pre-line;
    }
    .trade-stepline{
      margin-top:10px;
      font-size:13px;
      color: rgba(255,255,255,0.78);
      line-height:1.55;
      white-space:pre-line;
    }
  `;
  document.head.appendChild(st);
}

// ----------------------------
// UI 유틸
// ----------------------------
function showNote(msg, type = "", alsoAlert = false) {
  const el = $("note");
  if (el) {
    el.style.display = msg ? "block" : "none";
    el.className = "note" + (type ? " " + type : "");
    el.textContent = msg || "";
  }

  // note가 없거나 화면에서 놓치면 알럿까지
  if (alsoAlert && msg) alert(msg);
}

function setText(id, v) {
  const el = $(id);
  if (!el) return;
  el.textContent = v;
}

function setHTML(id, v) {
  const el = $(id);
  if (!el) return;
  el.innerHTML = v;
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
  return ["OPEN", "TAKEN", "PAID", "RELEASED", "CANCELED", "DISPUTED", "RESOLVED"][n] ?? String(n);
}

function tokenSymbolByAddr(addr) {
  const a = (addr || "").toLowerCase();
  if (HEX_ADDR && a === String(HEX_ADDR).toLowerCase()) return "HEX";
  if (USDT_ADDR && a === String(USDT_ADDR).toLowerCase()) return "USDT";
  if (VET_ADDR && a === String(VET_ADDR).toLowerCase()) return "VET";
  return addr || "-";
}

function setBtnState(id, enabled, reason = "") {
  const el = $(id);
  if (!el) return;

  el.disabled = !enabled;
  el.style.opacity = enabled ? "1" : "0.45";
  el.style.pointerEvents = enabled ? "auto" : "none";
  el.title = !enabled && reason ? reason : "";
}

function getStepInfoEl() {
  return $("stepInfo") || $("tradeSteps") || $("progressInfo");
}

function renderStatusBar({ seller, buyer, status }, me) {
  const host = getStepInfoEl();
  if (!host) return;

  let bar = document.getElementById("tradeStatusBar");
  if (!bar) {
    bar = document.createElement("div");
    bar.id = "tradeStatusBar";
    bar.className = "trade-statusbar";
    host.parentNode?.insertBefore(bar, host);
  }

  const st = Number(status ?? 0);
  const sellerL = (seller || "").toLowerCase();
  const buyerL = (buyer || "").toLowerCase();
  const meL = (me || "").toLowerCase();

  let role = "미연결";
  if (meL) {
    if (meL === sellerL) role = "판매자";
    else if (buyer && buyer !== ethers.ZeroAddress && meL === buyerL) role = "구매자";
    else role = "당사자 아님";
  }

  let next = "";
  if (!meL) next = "지갑을 연결하면 내 역할에 맞는 버튼만 활성화됩니다.";
  else if (st === 0) next = "구매자: 거래신청(acceptTrade) 완료 전 입금하지 마세요.\n중복입금 방지 목적입니다.";
  else if (st === 1) next = "구매자: 입금 후 입금완료(markPaid)를 누르세요.";
  else if (st === 2) next = "판매자: 입금 확인 후 토큰 이체(release)를 누르세요.";
  else if (st === 3) next = "완료: 토큰 이체가 끝났습니다.";
  else if (st === 4) next = "취소: 거래가 취소되었습니다.";
  else if (st === 5) next = "분쟁: 중재자 해결 필요.";
  else next = "현재 상태에서 추가 진행이 제한됩니다.";

  const chipClass = st === 3 ? "ok" : (st === 4 || st === 5) ? "bad" : "";

  bar.innerHTML = `
    <div class="row">
      <span class="trade-chip ${chipClass}">상태: ${statusLabel(st)}</span>
      <span class="trade-chip">내 역할: ${role}</span>
      <span class="trade-chip">판매자: ${shortAddr(seller)}</span>
      <span class="trade-chip">구매자: ${buyer && buyer !== ethers.ZeroAddress ? shortAddr(buyer) : "-"}</span>
    </div>
    <div class="trade-next">${next}</div>
  `;
}

function renderStepInfoText({ status }, me) {
  const el = getStepInfoEl();
  if (!el) return;

  const st = Number(status ?? 0);

  let msg = "";
  if (st === 0) {
    msg =
      "1) 구매자: 거래신청(acceptTrade)\n" +
      "2) 구매자: 입금 후 입금완료(markPaid)\n" +
      "3) 판매자: 입금 확인 후 토큰 이체(release)\n" +
      "4) 판매자: 필요 시 판매취소(cancelBySeller)";
  } else if (st === 1) {
    msg = "현재: TAKEN\n다음: 구매자 markPaid";
  } else if (st === 2) {
    msg = "현재: PAID\n다음: 판매자 release";
  } else {
    msg = `현재: ${statusLabel(st)}`;
  }

  if (!me) msg += "\n(지갑 미연결)";

  el.classList.add("trade-stepline");
  el.textContent = msg;
}

// ----------------------------
// 컨트랙트
// ----------------------------
function getReadProvider() {
  return provider ?? new ethers.JsonRpcProvider(RPC_URL);
}

function getVetEx(readOnly = true) {
  const p = getReadProvider();
  if (!VET_EX) throw new Error("CONFIG.CONTRACT.vetEX 없음");
  if (!ABI?.length) throw new Error("ABI 없음");
  if (!readOnly) {
    if (!signer) throw new Error("signer 없음 (지갑 연결 필요)");
    return new ethers.Contract(VET_EX, ABI, signer);
  }
  return new ethers.Contract(VET_EX, ABI, p);
}

async function readTokenBalance(tokenAddr, ownerAddr, fallbackDecimals = 18) {
  const t = new ethers.Contract(tokenAddr, ERC20_ABI, getReadProvider());
  let d = fallbackDecimals;
  try {
    d = Number(await t.decimals());
  } catch {}
  const b = await t.balanceOf(ownerAddr);
  return { b, d };
}

async function refreshHeaderBalances() {
  if (!account) return;
  if ($("walletAddr")) setText("walletAddr", shortAddr(account));

  try {
    const hexAddr = CONFIG?.TOKENS?.HEX?.address;
    const usdtAddr = CONFIG?.TOKENS?.USDT?.address;

    if ($("myHexBal")) {
      if (hexAddr) {
        const { b, d } = await readTokenBalance(hexAddr, account, CONFIG?.TOKENS?.HEX?.decimals ?? 18);
        setText("myHexBal", ethers.formatUnits(b, d));
      } else setText("myHexBal", "-");
    }

    if ($("myUsdtBal")) {
      if (usdtAddr) {
        const { b, d } = await readTokenBalance(usdtAddr, account, CONFIG?.TOKENS?.USDT?.decimals ?? 18);
        setText("myUsdtBal", ethers.formatUnits(b, d));
      } else setText("myUsdtBal", "-");
    }
  } catch (e) {
    console.error(e);
    showNote("잔고 조회 실패 (RPC/토큰주소/네트워크 확인)", "bad");
  }
}

async function connectWallet() {
  if (!window.ethereum) {
    showNote("지갑이 없습니다. MetaMask/Rabby 설치 필요", "bad", true);
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
  return u.searchParams.get("id") || null;
}

// ----------------------------
// revert 디코딩
// ----------------------------
function decodeRevertIfPossible(e) {
  const custom = decodeCustomError(e);
  if (custom) return custom;

  try {
    const iface = new ethers.Interface(ABI);
    const data =
      e?.data ||
      e?.error?.data ||
      e?.info?.error?.data ||
      e?.info?.payload?.params?.[0]?.data ||
      null;

    if (!data || typeof data !== "string") return null;
    const parsed = iface.parseError(data);
    if (!parsed) return null;

    const args = parsed.args ? Array.from(parsed.args).map((x) => String(x)) : [];
    return `${parsed.name}${args.length ? " (" + args.join(", ") + ")" : ""}`;
  } catch {
    return null;
  }
}

// ----------------------------
// 버튼 게이팅
// ----------------------------
function gateButtons({ seller, buyer, status }) {
  const me = (account || "").toLowerCase();
  const sellerL = (seller || "").toLowerCase();
  const buyerL = (buyer || "").toLowerCase();
  const st = Number(status ?? 0);

  const buyerIsZero = !buyer || buyer === ethers.ZeroAddress;
  const isSeller = me && sellerL && me === sellerL;
  const isBuyer = me && buyerL && me === buyerL;

  if ($("btnAccept")) $("btnAccept").textContent = "거래신청";
  if ($("btnPaid")) $("btnPaid").textContent = "입금 완료";
  if ($("btnRelease")) $("btnRelease").textContent = "토큰 이체";
  if ($("btnCancel")) $("btnCancel").textContent = "판매 취소";

  const needConnect = "지갑 연결이 필요합니다.";
  const needBuyer = "구매자 지갑으로만 가능합니다.";
  const needSeller = "판매자 지갑으로만 가능합니다.";
  const badStatus = (need) => `현재 상태(${statusLabel(st)})에서는 ${need}할 수 없습니다.`;

  const canAccept = !!account && st === 0 && (buyerIsZero || isBuyer);
  let acceptReason = "";
  if (!account) acceptReason = needConnect;
  else if (st !== 0) acceptReason = badStatus("거래신청");
  else if (!buyerIsZero && !isBuyer) acceptReason = "지정된 구매자만 거래신청 가능합니다.";

  const canPaid = !!account && st === 1 && isBuyer;
  let paidReason = "";
  if (!account) paidReason = needConnect;
  else if (st !== 1) paidReason = badStatus("입금완료 표시");
  else if (!isBuyer) paidReason = needBuyer;

  const canRelease = !!account && st === 2 && isSeller;
  let releaseReason = "";
  if (!account) releaseReason = needConnect;
  else if (st !== 2) releaseReason = badStatus("토큰 이체");
  else if (!isSeller) releaseReason = needSeller;

  const canCancel = !!account && (st === 0 || st === 1) && isSeller;
  let cancelReason = "";
  if (!account) cancelReason = needConnect;
  else if (!(st === 0 || st === 1)) cancelReason = badStatus("판매취소");
  else if (!isSeller) cancelReason = needSeller;

  setBtnState("btnAccept", canAccept, acceptReason);
  setBtnState("btnPaid", canPaid, paidReason);
  setBtnState("btnRelease", canRelease, releaseReason);
  setBtnState("btnCancel", canCancel, cancelReason);
}

// ----------------------------
// 핵심: token transfer를 provider.call로 시뮬레이션
// ----------------------------
async function simulateEscrowTransfer(tokenAddr, to, amount) {
  const p = getReadProvider();
  const erc20Iface = new ethers.Interface(ERC20_ABI);

  const data = erc20Iface.encodeFunctionData("transfer", [to, amount]);

  try {
    // from=VET_EX로 잡아 "vetEX가 보낸다면" 전송이 되는지 확인
    const ret = await p.call({
      to: tokenAddr,
      from: VET_EX,
      data,
    });

    // 표준 ERC20 returns(bool) → 32바이트 true/false
    // ret이 0x 또는 너무 짧으면 "non-standard" 가능
    if (!ret || ret === "0x") {
      return { ok: true, kind: "nostd", raw: ret };
    }

    // bool 디코드
    let ok = true;
    try {
      const [b] = erc20Iface.decodeFunctionResult("transfer", ret);
      ok = !!b;
    } catch {
      ok = true; // 디코딩 실패면 non-standard로 보고 통과
      return { ok, kind: "nostd", raw: ret };
    }
    return { ok, kind: "bool", raw: ret };
  } catch (e) {
    return { ok: false, kind: "revert", err: e };
  }
}

async function readEscrowTokenBalance(tokenAddr, decFallback = 18) {
  const t = new ethers.Contract(tokenAddr, ERC20_ABI, getReadProvider());
  let d = decFallback;
  try {
    d = Number(await t.decimals());
  } catch {}
  const bal = await t.balanceOf(VET_EX);
  return { bal, d };
}

// ----------------------------
// Firestore + Onchain 로드
// ----------------------------
async function loadTrade(tradeId) {
  setText("subTitle", `tradeId = ${tradeId}`);

  if (!VET_EX) {
    showNote("CONFIG.CONTRACT.vetEX 없음 (config.js 확인)", "bad", true);
    return null;
  }
  if (!ABI?.length) {
    showNote("ABI 없음 (contract.js 확인)", "bad", true);
    return null;
  }
  if (!RPC_URL) {
    showNote("CONFIG.RPC_URL 없음", "bad", true);
    return null;
  }

  // Firestore meta
  let meta = null;
  if (db) {
    try {
      const ref = doc(db, "trades", String(tradeId));
      const snap = await getDoc(ref);
      if (snap.exists()) meta = snap.data();
    } catch (e) {
      console.warn("firestore meta load fail:", e);
    }
  }

  // Onchain
  const c = getVetEx(true);
  let on;
  try {
    on = await c.getTrade(tradeId);
  } catch (e) {
    console.error(e);
    const decoded = decodeRevertIfPossible(e);
    showNote("온체인 getTrade 실패: " + (decoded || e?.shortMessage || e?.message || "unknown"), "bad", true);
    return null;
  }

  const seller = on.seller ?? on[0];
  const buyer = on.buyer ?? on[1];
  const token = on.token ?? on[2];
  const amount = on.amount ?? on[3];
  const fiatAmount = on.fiatAmount ?? on[4];
  const paymentRef = on.paymentRef ?? on[5];
  const fiat = on.fiat ?? on[8];
  const status = on.status ?? on[9];

  const sym = tokenSymbolByAddr(token);

  let dec = 18;
  try {
    const tt = new ethers.Contract(token, ERC20_ABI, getReadProvider());
    dec = Number(await tt.decimals());
  } catch {
    dec =
      sym === "HEX" ? (CONFIG?.TOKENS?.HEX?.decimals ?? 18)
      : sym === "USDT" ? (CONFIG?.TOKENS?.USDT?.decimals ?? 18)
      : 18;
  }

  setText("vToken", sym);
  setText("vAmount", ethers.formatUnits(amount, dec));
  setText("vFiat", fiatLabel(fiat));
  setText("vFiatAmount", Number(fiatAmount ?? 0).toLocaleString());
  setText("vStatus", statusLabel(status ?? 0));
  setText("vPaymentRef", paymentRef && paymentRef !== ethers.ZeroHash ? String(paymentRef) : "-");
  setText("vSeller", seller ? String(seller) : "-");
  setText("vBuyer", buyer && buyer !== ethers.ZeroAddress ? String(buyer) : "-");

  let sellerSns = meta?.sellerSns || "-";
  try {
    const [kakaoId, telegramId, registered] = await c.getSellerContact(seller);
    if (registered) {
      const kk = kakaoId ? `kakao: ${kakaoId}` : "";
      const tg = telegramId ? `tg: ${telegramId}` : "";
      const join = [kk, tg].filter(Boolean).join(" / ");
      sellerSns = join || sellerSns;
    }
  } catch {}
  setText("vSellerSns", sellerSns);

  if ($("vVetBadge")) {
    setHTML("vVetBadge", sym === "HEX" ? `<span class="badge">매수자에게 VET 보상</span>` : `-`);
  }

  renderStatusBar({ seller, buyer, status }, account);
  renderStepInfoText({ status }, account);
  gateButtons({ seller, buyer, status });

  return {
    meta,
    on: { seller, buyer, token, amount, fiatAmount, paymentRef, fiat, status, dec, sym },
  };
}

// ----------------------------
// 액션
// ----------------------------
async function doAccept(tradeId) {
  showNote("");
  if (!account) await connectWallet();

  const c = getVetEx(false);
  try {
    showNote("거래신청(acceptTrade) 전송...", "");
    const tx = await c.acceptTrade(tradeId);
    await tx.wait();
    showNote("거래신청 완료", "ok");
    await loadTrade(tradeId);
  } catch (e) {
    console.error(e);
    const decoded = decodeRevertIfPossible(e);
    showNote(decoded || e?.shortMessage || e?.message || String(e), "bad", true);
  }
}

function toRefHash(str) {
  if (!str) return ethers.ZeroHash;
  return ethers.keccak256(ethers.toUtf8Bytes(str));
}

async function doPaid(tradeId) {
  showNote("");
  if (!account) await connectWallet();

  const c = getVetEx(false);
  try {
    const raw = ($("inpRef")?.value || "").trim();
    const ref = toRefHash(raw);

    showNote("입금완료 표시(markPaid) 전송...", "");
    const tx = await c.markPaid(tradeId, ref);
    await tx.wait();
    showNote("입금완료 표시 완료", "ok");
    await loadTrade(tradeId);
  } catch (e) {
    console.error(e);
    const decoded = decodeRevertIfPossible(e);
    showNote(decoded || e?.shortMessage || e?.message || String(e), "bad", true);
  }
}

async function doRelease(tradeId) {
  showNote("");
  if (!account) await connectWallet();

  const cRead = getVetEx(true);
  const c = getVetEx(false);

  try {
    showNote("토큰 이체(release) 사전 점검...", "");

    const on = await cRead.getTrade(tradeId);
    const seller = on.seller ?? on[0];
    const buyer = on.buyer ?? on[1];
    const token = on.token ?? on[2];
    const amount = on.amount ?? on[3];
    const status = Number(on.status ?? on[9]);

    if (String(seller).toLowerCase() !== String(account).toLowerCase()) {
      throw new Error(`판매자만 토큰 이체가 가능합니다.\n현재=${shortAddr(account)} / 판매자=${shortAddr(seller)}`);
    }
    if (status !== 2) {
      throw new Error(`토큰 이체 불가 상태입니다.\n현재 상태=${statusLabel(status)}`);
    }
    if (!buyer || buyer === ethers.ZeroAddress) {
      throw new Error("구매자 주소가 비어있습니다.\nacceptTrade 처리 여부를 확인하세요.");
    }

    // 에스크로 잔고 체크
    const { bal, d } = await readEscrowTokenBalance(token, 18);
    if (bal < amount) {
      const need = ethers.formatUnits(amount, d);
      const cur = ethers.formatUnits(bal, d);
      throw new Error(`에스크로 잔고 부족\n필요=${need}\n현재=${cur}`);
    }

    // 가장 중요: token transfer 시뮬레이션
    showNote("토큰 전송 시뮬레이션(eth_call) 중...", "");
    const sim = await simulateEscrowTransfer(token, buyer, amount);

    if (!sim.ok) {
      const decoded = decodeRevertIfPossible(sim.err) || sim.err?.shortMessage || sim.err?.message || "token revert";
      throw new Error(
        "토큰 전송이 컨트랙트 레벨에서 막혀있습니다.\n" +
        "즉, vetEX가 buyer에게 토큰을 보낼 수 없는 상태입니다.\n\n" +
        "token revert: " + decoded + "\n\n" +
        "원인 후보:\n" +
        "- 토큰 전송이 비활성화(런치 전)\n" +
        "- vetEX 주소가 화이트리스트에 없음\n" +
        "- 특정 컨트랙트/주소 전송 제한(블랙리스트/제한)\n"
      );
    }

    // bool인데 false면 더 명확히
    if (sim.kind === "bool" && sim.raw && sim.raw !== "0x") {
      // 여기서 ok=true라서 통과
    }

    showNote("토큰 이체(release) 전송...", "");

    const gas = await c.release.estimateGas(tradeId).catch(() => null);
    const overrides = gas ? { gasLimit: (gas * 130n) / 100n } : { gasLimit: 900000n };

    const tx = await c.release(tradeId, overrides);
    await tx.wait();

    showNote("토큰 이체 완료", "ok", true);
    await loadTrade(tradeId);
  } catch (e) {
    console.error(e);
    const decoded = decodeRevertIfPossible(e);
    showNote(decoded || e?.shortMessage || e?.message || String(e), "bad", true);
  }
}

async function doCancel(tradeId) {
  showNote("");
  if (!account) await connectWallet();

  const c = getVetEx(false);
  try {
    showNote("판매 취소(cancelBySeller) 전송...", "");
    const tx = await c.cancelBySeller(tradeId);
    await tx.wait();
    showNote("판매 취소 완료", "ok");
    await loadTrade(tradeId);
  } catch (e) {
    console.error(e);
    const decoded = decodeRevertIfPossible(e);
    showNote(decoded || e?.shortMessage || e?.message || String(e), "bad", true);
  }
}

// ----------------------------
// boot
// ----------------------------
(async function boot() {
  injectTradeStyleOnce();

  try {
    const tradeId = getTradeIdFromQuery();
    if (!tradeId) {
      showNote("trade.html?id=숫자 형식으로 접근하세요.", "bad", true);
      return;
    }

    await loadTrade(tradeId);

    $("btnConnect")?.addEventListener("click", async () => {
      await connectWallet();
      await loadTrade(tradeId);
    });

    $("btnAccept")?.addEventListener("click", () => doAccept(tradeId));
    $("btnPaid")?.addEventListener("click", () => doPaid(tradeId));
    $("btnRelease")?.addEventListener("click", () => doRelease(tradeId));
    $("btnCancel")?.addEventListener("click", () => doCancel(tradeId));

    if (window.ethereum?.on) {
      window.ethereum.on("accountsChanged", async (accs) => {
        account = accs?.[0] || null;
        signer = null;
        provider = null;

        if (account) await connectWallet();
        await loadTrade(tradeId);
      });

      window.ethereum.on("chainChanged", async () => {
        signer = null;
        provider = null;
        if (account) await connectWallet();
        await loadTrade(tradeId);
      });
    }
  } catch (e) {
    console.error(e);
    showNote(e?.message || String(e), "bad", true);
  }
})();
