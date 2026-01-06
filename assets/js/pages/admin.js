import { ethers } from "https://cdn.jsdelivr.net/npm/ethers@6.14.0/dist/ethers.min.js";
import { connectWallet, provider, signer, account } from "../web3.js";
import { CONFIG } from "../config.js";
import { ABI } from "../contract.js"; // ABI 배열 export 되어있다고 가정

const $ = (id) => document.getElementById(id);

function setNote(msg, type = "") {
  const el = $("note");
  el.className = "note" + (type ? " " + type : "");
  el.textContent = msg || "";
}

function isAddress(v) {
  try { return ethers.isAddress(v); } catch { return false; }
}

async function getContract() {
  return new ethers.Contract(CONFIG.CONTRACT.vetEX, ABI, signer);
}

async function refresh() {
  setNote("");

  const c = await getContract();
  const pending = await c.pendingUsdtFee(); // uint256

  $("pendingRaw").textContent = pending.toString();

  // 기본 출금주소를 내 지갑으로 자동 채우기(원치 않으면 제거)
  if (!$("toAddr").value && account) $("toAddr").value = account;
}

async function onConnect() {
  const addr = await connectWallet();
  $("myAddr").textContent = addr;

  // chain 표시
  const net = await provider.getNetwork();
  $("netPill").textContent = `chainId ${net.chainId.toString()}`;

  await refresh();
}

async function withdrawAll() {
  setNote("");

  const to = $("toAddr").value.trim();
  if (!isAddress(to)) {
    setNote("출금 주소가 올바르지 않습니다.", "bad");
    return;
  }

  const c = await getContract();
  const pending = await c.pendingUsdtFee();

  if (pending === 0n) {
    setNote("현재 pendingUsdtFee가 0 입니다.", "bad");
    return;
  }

  setNote("트랜잭션 전송 중...", "");

  const tx = await c.withdrawUsdtFee(to, pending);
  setNote(`전송 완료. tx: ${tx.hash}`, "ok");

  await tx.wait();
  await refresh();
  setNote("전액 이체 완료 및 새로고침 완료", "ok");
}

$("btnConnect").onclick = onConnect;
$("btnRefresh").onclick = refresh;
$("btnWithdrawAll").onclick = withdrawAll;

// 페이지 진입 시 자동 연결 시도(선택)
if (window.ethereum) {
  // 자동으로 메타마스크가 이미 연결돼 있으면 바로 표시
  // 사용자가 원치 않으면 이 부분 삭제 가능
  window.ethereum.request({ method: "eth_accounts" }).then(async (accs) => {
    if (accs && accs.length) await onConnect();
  }).catch(() => {});
} else {
  setNote("메타마스크가 필요합니다.", "bad");
}
