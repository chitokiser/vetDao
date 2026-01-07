// /assets/js/pages/profile.js
import {
  doc,
  getDoc,
  setDoc,
  serverTimestamp,
} from "https://www.gstatic.com/firebasejs/10.7.0/firebase-firestore.js";

const db = window.db;
const $ = (id) => document.getElementById(id);

// UI refs
const elMyAddr = $("myAddr");
const elStatus = $("status");
const elNote = $("note");
const elUserDocKey = $("userDocKey");

const inpKakao = $("kakaoId");
const inpTele = $("telegramId");

const inpMeetPlace = $("meetPlace");
const selKrBank = $("krBank");
const inpKrAcc = $("krAccount");
const selVnBank = $("vnBank");
const inpVnAcc = $("vnAccount");

const btnConnect = $("btnConnect");
const btnLoad = $("btnLoad");
const btnSave = $("btnSave");
const btnSave2 = $("btnSave2");

let provider = null;
let signer = null;
let userAddress = null;

function setText(el, text) {
  if (!el) return;
  el.textContent = text;
}

function showNote(msg, ok = true) {
  if (!elNote) return;
  elNote.style.display = msg ? "block" : "none";
  elNote.className = ok ? "note ok" : "note bad";
  elNote.textContent = msg || "";
}

function setStatus(s) {
  setText(elStatus, s || "-");
}

function setAddrUI(addr) {
  const short = addr ? `${addr.slice(0, 6)}...${addr.slice(-4)}` : "-";
  setText(elMyAddr, short);
  if (elUserDocKey) setText(elUserDocKey, addr ? addr.toLowerCase() : "-");
}

function getPayloadAll() {
  return {
    wallet: userAddress ? userAddress.toLowerCase() : null,

    // SNS (firebase)
    kakaoId: (inpKakao?.value || "").trim(),
    telegramId: (inpTele?.value || "").trim(),

    // profile (firebase)
    meetPlace: (inpMeetPlace?.value || "").trim(),
    krBank: (selKrBank?.value || "").trim(),
    krAccount: (inpKrAcc?.value || "").trim(),
    vnBank: (selVnBank?.value || "").trim(),
    vnAccount: (inpVnAcc?.value || "").trim(),
  };
}

function validateAll(p) {
  if (!userAddress) return "지갑을 먼저 연결하세요.";

  // 판매등록 조건: SNS 1개 이상
  if (!p.kakaoId && !p.telegramId) return "카카오톡 또는 텔레그램 중 1개 이상 입력하세요.";

  if (p.krAccount && !p.krBank) return "한국 계좌번호를 입력했다면 한국 은행도 선택하세요.";
  if (p.vnAccount && !p.vnBank) return "베트남 계좌번호를 입력했다면 베트남 은행도 선택하세요.";

  return null;
}

async function connectWallet() {
  try {
    if (!window.ethereum) {
      alert("MetaMask/Rabby 지갑이 필요합니다.");
      return;
    }
    if (!window.ethers) {
      alert("ethers 로드가 안되었습니다. ethers.umd.min.js 로드를 확인하세요.");
      return;
    }

    provider = new window.ethers.BrowserProvider(window.ethereum);
    await provider.send("eth_requestAccounts", []);
    signer = await provider.getSigner();
    userAddress = await signer.getAddress();

    setAddrUI(userAddress);
    setStatus("연결됨");
    showNote("지갑 연결 완료", true);

    await loadAllFromFirestore();
  } catch (e) {
    console.error(e);
    showNote(e?.message || "지갑 연결 실패", false);
    setStatus("미연결");
  }
}

async function loadAllFromFirestore() {
  try {
    if (!db) throw new Error("Firestore(db)가 초기화되지 않았습니다. firebase.js 로드를 확인하세요.");
    if (!userAddress) throw new Error("지갑을 먼저 연결하세요.");

    setStatus("불러오는중...");

    const ref = doc(db, "users", userAddress.toLowerCase());
    const snap = await getDoc(ref);

    if (!snap.exists()) {
      setStatus("불러오기 완료");
      showNote("저장된 프로필이 없습니다. 입력 후 저장하세요.", true);
      return;
    }

    const d = snap.data() || {};

    // SNS
    if (inpKakao) inpKakao.value = d.kakaoId || "";
    if (inpTele) inpTele.value = d.telegramId || "";

    // profile
    if (inpMeetPlace) inpMeetPlace.value = d.meetPlace || "";
    if (selKrBank) selKrBank.value = d.krBank || "";
    if (inpKrAcc) inpKrAcc.value = d.krAccount || "";
    if (selVnBank) selVnBank.value = d.vnBank || "";
    if (inpVnAcc) inpVnAcc.value = d.vnAccount || "";

    setStatus("불러오기 완료");
    showNote("프로필 불러오기 완료", true);
  } catch (e) {
    console.error(e);
    setStatus("불러오기 실패");
    showNote(e?.message || "불러오기 실패", false);
  }
}

async function saveAllToFirestore() {
  try {
    if (!db) {
      showNote("Firestore(db)가 초기화되지 않았습니다. firebase.js 로드를 확인하세요.", false);
      return;
    }
    if (!userAddress) {
      showNote("지갑을 먼저 연결하세요.", false);
      return;
    }

    const p = getPayloadAll();
    const err = validateAll(p);
    if (err) {
      showNote(err, false);
      return;
    }

    setStatus("저장중(파이어베이스)...");

    const ref = doc(db, "users", userAddress.toLowerCase());
    await setDoc(
      ref,
      {
        ...p,
        updatedAt: serverTimestamp(),
      },
      { merge: true }
    );

    setStatus("저장 완료");
    showNote("저장 완료(파이어베이스)", true);
  } catch (e) {
    console.error(e);
    setStatus("저장 실패");

    const msg = String(e?.message || e);
    if (msg.includes("Missing or insufficient permissions")) {
      showNote("파이어베이스 권한(rules) 때문에 저장이 거부되었습니다. rules를 수정해야 합니다.", false);
    } else {
      showNote(msg, false);
    }
  }
}

function bind() {
  if (btnConnect) btnConnect.addEventListener("click", () => connectWallet());

  if (btnLoad) btnLoad.addEventListener("click", (e) => {
    e.preventDefault();
    loadAllFromFirestore();
  });

  if (btnSave) btnSave.addEventListener("click", (e) => {
    e.preventDefault();
    saveAllToFirestore();
  });

  if (btnSave2) btnSave2.addEventListener("click", (e) => {
    e.preventDefault();
    saveAllToFirestore();
  });

  if (window.ethereum?.on) {
    window.ethereum.on("accountsChanged", (accs) => {
      userAddress = accs?.[0] || null;
      provider = null;
      signer = null;
      setAddrUI(userAddress);
      setStatus(userAddress ? "연결됨(변경됨)" : "미연결");
      showNote("", true);
    });

    window.ethereum.on("chainChanged", () => {
      provider = null;
      signer = null;
      setStatus(userAddress ? "네트워크 변경됨" : "미연결");
    });
  }
}

bind();
