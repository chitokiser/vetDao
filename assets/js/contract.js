

// /assets/js/contract.js
// config.js를 import 하지 않습니다. (window.CONFIG 사용 구조)

export const ABI = [
  // ===== view =====
  "function getTrade(uint256 tradeId) view returns (tuple(address seller,address buyer,address token,uint256 amount,uint256 fiatAmount,bytes32 paymentRef,uint64 createdAt,uint64 paidAt,uint8 fiat,uint8 status))",
  "function getSellerContact(address seller) view returns (string kakaoId, string telegramId, bool registered)",
  "function feeBps() view returns (uint16)",
  "function arbitrator() view returns (address)",
  "function vetBank() view returns (address)",

  // ===== actions =====
  "function acceptTrade(uint256 tradeId) external",
  "function markPaid(uint256 tradeId, bytes32 paymentRef) external",
  "function release(uint256 tradeId) external",
  "function cancelBySeller(uint256 tradeId) external",
  "function dispute(uint256 tradeId) external",
  "function resolveWinnerTakesAll(uint256 tradeId, address winner) external",
  "function resolveSplit(uint256 tradeId, uint256 amountToBuyer) external",

  // ===== events (리스트 표시용) =====
  "event TradeOpened(uint256 indexed tradeId, address indexed seller, address token, uint256 amount, uint8 fiat)"
];



