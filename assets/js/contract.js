// /assets/js/contract.js
// vetEX ABI + 공용 전역(window.ABI) 제공
// ethers는 UMD(window.ethers)로 로드되어 있어야 합니다.

(() => {
  // vetEX 핵심 ABI (판매/SNS/조회/이벤트)
  // 필요 함수만 넣은 "최소 ABI" 입니다.
  const ABI = [
    // ----- Seller Contact -----
    "function registerSellerContact(string kakaoId, string telegramId) external",
    "function updateSellerContact(string kakaoId, string telegramId) external",
    "function getSellerContact(address seller) external view returns (string kakaoId, string telegramId, bool registered)",

    // ----- Trade Flow -----
    "function openTrade(address token,uint256 amount,address buyer,uint8 fiat,uint256 fiatAmount,bytes32 paymentRef) external returns (uint256 tradeId)",
    "function acceptTrade(uint256 tradeId) external",
    "function markPaid(uint256 tradeId, bytes32 paymentRef) external",
    "function release(uint256 tradeId) external",
    "function cancelBySeller(uint256 tradeId) external",
    "function dispute(uint256 tradeId) external",
    "function resolveWinnerTakesAll(uint256 tradeId, address winner) external",

    // ----- Read -----
    "function nextTradeId() external view returns (uint256)",
    "function getTrade(uint256 tradeId) external view returns (tuple(address seller,address buyer,address token,uint256 amount,uint256 fiatAmount,bytes32 paymentRef,uint64 createdAt,uint64 paidAt,uint8 fiat,uint8 status))",

    // ----- Events -----
    "event SellerContactRegistered(address indexed seller)",
    "event SellerContactUpdated(address indexed seller)",

    "event TradeOpened(uint256 indexed tradeId,address indexed seller,address token,uint256 amount,uint8 fiat)",
    "event TradeTaken(uint256 indexed tradeId,address indexed buyer)",
    "event MarkedPaid(uint256 indexed tradeId,bytes32 paymentRef)",
    "event Released(uint256 indexed tradeId,uint256 toBuyer,uint256 feeTaken)",
    "event Canceled(uint256 indexed tradeId)",
    "event Disputed(uint256 indexed tradeId)",
    "event Resolved(uint256 indexed tradeId)",
  ];

  window.ABI = ABI;

  // (선택) 간단한 헬퍼도 전역에 노출하고 싶으면 여기서 추가 가능
  // window.__abiReady = true;

  console.log("[contract.js] ABI loaded:", ABI.length);
})();
