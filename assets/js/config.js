// /assets/js/config.js
window.CONFIG = {
  CHAIN_ID: 204,
  RPC_URL: "https://opbnb-mainnet-rpc.bnbchain.org",
  DEPLOY_BLOCK: 125357812,

  CONTRACT: {
    vetEX: "0xC692e55CCBD28B4C2bf56C4d58F96b510E10C8e8"
  },
  TOKENS: {
    HEX: { symbol: "HEX", address: "0x41F2Ea9F4eF7c4E35ba1a8438fC80937eD4E5464", decimals: 18 },
    VET: { symbol: "VET", address: "0xff8eCA08F731EAe46b5e7d10eBF640A8Ca7BA3D4", decimals: 0 },
  },

  // 결제 대기 권고 시간(분) - 온체인 강제 없음, UX 표시 전용
  PAYMENT_TIMEOUT_MIN: 30,
};
