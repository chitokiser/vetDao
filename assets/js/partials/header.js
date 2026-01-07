// \assets\js\partials\header.js

import { ethers } from "https://cdn.jsdelivr.net/npm/ethers@6.14.0/dist/ethers.min.js";
import { connectWallet, provider, signer, account } from "../web3.js";

const CONFIG = window.CONFIG;

const $ = (id) => document.getElementById(id);

function showHdrNote(msg, type = "") {
  const el = $("hdrNote");
  if (!el) return;
  el.style.display = msg ? "block" : "none";
  el.className = "note" + (type ? " " + type : "");
  el.textContent = msg || "";
}

function shortAddr(a) {
  if (!a) return "-";
  return a.slice(0, 6) + "..." + a.slice(-4);
}

async function readErc20Balance(tokenAddr, owner, decimals) {
  const erc20 = new ethers.Contract(
    tokenAddr,
    ["function balanceOf(address) view returns (uint256)"],
    provider
  );
  const bal = await erc20.balanceOf(owner);
  return ethers.formatUnits(bal, decimals ?? 18);
}

async function refreshBalances() {
  if (!account) return;

  const hexAddr = CONFIG?.TOKENS?.HEX?.address;
  const usdtAddr = CONFIG?.TOKENS?.USDT?.address;

  const hexDec = CONFIG?.TOKENS?.HEX?.decimals ?? 18;
  const usdtDec = CONFIG?.TOKENS?.USDT?.decimals ?? 18;

  if ($("hdrAddr")) $("hdrAddr").textContent = shortAddr(account);

  try {
    if (hexAddr && hexAddr !== ethers.ZeroAddress) {
      const h = await readErc20Balance(hexAddr, account, hexDec);
      if ($("hdrHex")) $("hdrHex").textContent = Number(h).toLocaleString(undefined, { maximumFractionDigits: 6 });
    } else {
      if ($("hdrHex")) $("hdrHex").textContent = "-";
    }
  } catch {
    if ($("hdrHex")) $("hdrHex").textContent = "-";
  }

  try {
    if (usdtAddr && usdtAddr !== ethers.ZeroAddress) {
      const u = await readErc20Balance(usdtAddr, account, usdtDec);
      if ($("hdrUsdt")) $("hdrUsdt").textContent = Number(u).toLocaleString(undefined, { maximumFractionDigits: 6 });
    } else {
      if ($("hdrUsdt")) $("hdrUsdt").textContent = "-";
    }
  } catch {
    if ($("hdrUsdt")) $("hdrUsdt").textContent = "-";
  }

  if ($("hdrBalances")) $("hdrBalances").style.display = "inline-flex";
}

async function onConnect() {
  try {
    showHdrNote("");
    const addr = await connectWallet();
    showHdrNote(`지갑 연결됨: ${shortAddr(addr)}`, "ok");
    await refreshBalances();
  } catch (e) {
    console.error(e);
    showHdrNote(e?.shortMessage || e?.message || String(e), "bad");
  }
}

function bind() {
  const btn = $("hdrConnect");
  if (btn) btn.addEventListener("click", onConnect);

  // 이미 연결된 상태로 페이지 로드되는 경우 대비
  setTimeout(() => {
    if (account) refreshBalances();
  }, 200);
}

bind();
