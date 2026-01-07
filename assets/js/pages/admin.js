// /assets/js/pages/admin.js
import { ethers } from "https://cdn.jsdelivr.net/npm/ethers@6.14.0/dist/ethers.min.js";

const CONFIG = window.CONFIG;
const ABI = window.ABI;

const $ = (id) => document.getElementById(id);

let provider, signer, account;

function setNote(msg, type = "") {
  const el = $("note");
  if (!el) return;
  el.className = "note" + (type ? " " + type : "");
  el.textContent = msg || "";
}

function isAddress(v) {
  try { return ethers.isAddress(v); } catch { return false; }
}

function shortAddr(a) {
  return a ? a.slice(0, 6) + "..." + a.slice(-4) : "-";
}

async function connectWallet() {
  if (!window.ethereum) throw new Error("MetaMask/Rabby 필요");
  provider = new ethers.BrowserProvider(window.ethereum);
  await provider.send("eth_requestAccounts", []);
  signer = await provider.getSigner();
  account = await signer.getAddress();
  return account;
}

async function getContract() {
  if (!CONFIG?.CONTRACT?.vetEX) throw new Error("CONFIG.CONTRACT.vetEX 없음");
  if (!ABI?.length) throw new Error("window.ABI 없음");
  if (!signer) throw new Error("지갑 미연결");
  return new ethers.Contract(CONFIG.CONTRACT.vetEX, ABI, signer);
}

async function refresh() {
  setNote("");

  const c = await getContract();

  if (!c.pendingUsdtFee) {
    setNote("ABI에 pendingUsdtFee()가 없습니다. contract.js(window.ABI) 수정 필요", "bad");
    return;
  }

  const pending = await c.pendingUsdtFee(); // uint256
  $("pendingRaw").textContent = pending.toString();

  if (!$("toAddr").value && account) $("toAddr").value = account;
}

async function onConnect() {
  try {
    const addr = await connectWallet();
    $("myAddr").textContent = shortAddr(addr);

    const net = await provider.getNetwork();
    $("netPill").textContent = `chainId ${net.chainId.toString()}`;

    await refresh();
  } catch (e) {
    console.error(e);
    setNote(e?.shortMessage || e?.message || String(e), "bad");
  }
}

async function withdrawAll() {
  try {
    setNote("");

    const to = $("toAddr").value.trim();
    if (!isAddress(to)) {
      setNote("출금 주소가 올바르지 않습니다.", "bad");
      return;
    }

    const c = await getContract();

    if (!c.withdrawUsdtFee) {
      setNote("ABI에 withdrawUsdtFee(...)가 없습니다. contract.js(window.ABI) 수정 필요", "bad");
      return;
    }

    const pending = await c.pendingUsdtFee();
    if (pending === 0n) {
      setNote("현재 pendingUsdtFee가 0 입니다.", "bad");
      return;
    }

    setNote("트랜잭션 전송 중...", "");
    const tx = await c.withdrawUsdtFee(to, pending);
    setNote(`전송 완료 tx: ${tx.hash}`, "ok");

    await tx.wait();
    await refresh();
    setNote("전액 이체 완료", "ok");
  } catch (e) {
    console.error(e);
    setNote(e?.shortMessage || e?.message || String(e), "bad");
  }
}

$("btnConnect").onclick = onConnect;
$("btnRefresh").onclick = refresh;
$("btnWithdrawAll").onclick = withdrawAll;
