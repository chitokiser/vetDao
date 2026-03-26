// /assets/js/contract.js
// vetEX ABI (HEX only) + 공용 전역(window.ABI) 제공

(() => {
  const ABI = [
    // ----- Trade Flow -----
    "function openTrade(uint256 amount,address buyer,uint8 fiat,uint256 fiatAmount,bytes32 paymentRef) external returns (uint256 tradeId)",
    "function acceptTrade(uint256 tradeId,uint256 buyAmount) external",
    "function markPaid(uint256 tradeId,bytes32 paymentRef) external",
    "function release(uint256 tradeId) external",
    "function cancelBySeller(uint256 tradeId) external",
    "function cancelByBuyer(uint256 tradeId) external",
    "function dispute(uint256 tradeId) external",
    "function resolveWinnerTakesAll(uint256 tradeId,address winner) external",

    // ----- Admin -----
    "function setHexBank(address next) external",
    "function flushFeeNow(address to) external",

    // ----- Read -----
    "function nextTradeId() external view returns (uint256)",
    "function getTrade(uint256 tradeId) external view returns (tuple(address seller,address buyer,uint256 amount,uint256 buyAmount,uint256 fiatAmount,bytes32 paymentRef,uint64 createdAt,uint64 takenAt,uint64 paidAt,uint8 fiat,uint8 status))",
    "function feeBps() external view returns (uint16)",
    "function pendingHexFee() external view returns (uint256)",
    "function totalHexFeeCollected() external view returns (uint256)",
    "function hexBank() external view returns (address)",
    "function FEE_FLUSH_THRESHOLD() external view returns (uint256)",

    // ----- Events -----
    "event TradeOpened(uint256 indexed tradeId,address indexed seller,uint256 amount,uint8 fiat)",
    "event TradeTaken(uint256 indexed tradeId,address indexed buyer,uint256 buyAmount)",
    "event MarkedPaid(uint256 indexed tradeId,bytes32 paymentRef)",
    "event Released(uint256 indexed tradeId,uint256 toBuyer,uint256 toSeller,uint256 feeHex)",
    "event Canceled(uint256 indexed tradeId)",
    "event Disputed(uint256 indexed tradeId)",
    "event Resolved(uint256 indexed tradeId,address indexed winner)",
    "event FeeAccrued(uint256 indexed tradeId,uint256 feeHex,uint256 pending,uint256 totalCollected)",
    "event FeeFlushed(address indexed hexBank,uint256 amount,uint256 totalCollected)",
  ];

  window.ABI = ABI;
  console.log("[contract.js] ABI loaded:", ABI.length);
})();
