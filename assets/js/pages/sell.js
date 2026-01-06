import { ethers } from "https://cdn.jsdelivr.net/npm/ethers@6.14.0/dist/ethers.min.js";
import { ABI } from "../contract.js";
import { db } from "../firebase.js";
import { doc, setDoc, serverTimestamp } from "https://www.gstatic.com/firebasejs/10.7.0/firebase-firestore.js";

const CONFIG = window.CONFIG;
const $ = (id) => document.getElementById(id);
const dbg = window.__dbg || ((m) => console.log(m));

let provider, signer, account;

function setNote(msg, type = "") {
  const el = $("note");
  if (!el) return;
  el.className = "note" + (type ? " " + type : "");
  el.style.display = msg ? "block" : "none";
  el.textContent = msg || "";
  dbg("note: " + msg);
}

function shortAddr(a) {
  return a ? a.slice(0, 6) + "..." + a.slice(-4) : "-";
}

function updateTotal() {
  const a = Number($("amount")?.value || 0);
  const p = Number($("unitPrice")?.value || 0);
  const fiat = $("fiat")?.value || "KRW";
  if (!a || !p) {
    $("totalFiat").textContent = "-";
    return;
  }
  $("totalFiat").textContent = (a * p).toLocaleString() + " " + fiat;
}

function fiatEnum(fiat) {
  return fiat === "KRW" ? 0 : 1;
}

async function connectWallet() {
  dbg("connectWallet called");
  if (!window.ethereum) {
    throw new Error("window.ethereum 없음. 메타마스크/라비 설치 및 브라우저 확장 활성화 필요");
  }
  provider = new ethers.BrowserProvider(window.ethereum);
  await provider.send("eth_requestAccounts", []);
  signer = await provider.getSigner();
  account = await signer.getAddress();

  $("walletLine").textContent = "연결됨: " + shortAddr(account);
  dbg("wallet connected: " + account);
  return account;
}

async function getContract() {
  if (!signer) throw new Error("signer 없음(지갑 미연결)");
  return new ethers.Contract(CONFIG.CONTRACT.vetEX, ABI, signer);
}

function parseTradeId(receipt) {
  const iface = new ethers.Interface(ABI);
  for (const log of receipt.logs || []) {
    if (!log.address) continue;
    if (log.address.toLowerCase() !== CONFIG.CONTRACT.vetEX.toLowerCase()) continue;
    try {
      const parsed = iface.parseLog(log);
      if (parsed?.name === "TradeOpened") {
        return Number(parsed.args.tradeId);
      }
    } catch {}
  }
  return null;
}

async function onSubmit() {
  try {
    dbg("onSubmit start");
    setNote("");

    if (!account) await connectWallet();

    const tokenKey = $("token").value;
    const fiat = $("fiat").value;

    const amountText = ($("amount").value || "").trim();
    const unitPriceText = ($("unitPrice").value || "").trim();

    if (!amountText || Number(amountText) <= 0) return setNote("판매 수량을 입력하세요.", "bad");
    if (!unitPriceText || Number(unitPriceText) <= 0) return setNote("개당 가격을 입력하세요.", "bad");

    const tokenCfg = CONFIG?.TOKENS?.[tokenKey];
    if (!tokenCfg?.address) return setNote("config.js TOKENS 설정이 비었습니다.", "bad");

    const amountWei = ethers.parseUnits(amountText, tokenCfg.decimals ?? 18);
    const fiatAmount = Math.floor(Number(amountText) * Number(unitPriceText));

    const c = await getContract();

    setNote("트랜잭션 전송 중...", "");
    const tx = await c.openTrade(
      tokenCfg.address,
      amountWei,
      ethers.ZeroAddress,
      fiatEnum(fiat),
      fiatAmount,
      ethers.ZeroHash
    );

    dbg("tx sent: " + tx.hash);
    const receipt = await tx.wait();

    const tradeId = parseTradeId(receipt);
    if (!tradeId) {
      return setNote("openTrade는 성공했지만 TradeOpened 이벤트에서 tradeId를 못 찾았습니다. ABI/event 확인 필요", "bad");
    }

    const sellerSns = ($("sellerSns")?.value || "").trim() || "-";

    // Firestore 저장
    await setDoc(
      doc(db, "trades", String(tradeId)),
      {
        tradeId,
        seller: account,
        tokenSymbol: tokenKey,
        fiat,
        amount: Number(amountText),
        unitPrice: Number(unitPriceText),
        sellerSns,
        contract: CONFIG.CONTRACT.vetEX,
        updatedAt: serverTimestamp(),
        createdAt: serverTimestamp(),
      },
      { merge: true }
    );

    setNote("판매 등록 완료. tradeId=" + tradeId, "ok");
    dbg("firestore saved tradeId=" + tradeId);
  } catch (e) {
    console.error(e);
    setNote(e?.shortMessage || e?.message || String(e), "bad");
  }
}

function bind() {
  dbg("sell.js bind start");

  // 요소 존재 검증 로그
  const must = ["btnConnect", "btnSubmit", "note", "walletLine", "token", "fiat", "amount", "unitPrice", "totalFiat"];
  for (const id of must) {
    if (!$(id)) dbg("missing element id: " + id);
  }

  $("btnConnect")?.addEventListener("click", async () => {
    try {
      setNote("");
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

bind();
dbg("sell.js loaded end");
