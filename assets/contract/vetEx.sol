// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/*
  vetEX (Escrow) — HEX only
  - HEX P2P 에스크로 거래
  - 수수료(feeBps, 기본 0.5%): 구매자 수령액에서 차감
  - pendingHexFee >= 100 HEX 시 release()에서 hexBank로 자동 이체
  - totalHexFeeCollected: 누적 수수료 기록 (리셋 없음)
  - 오너가 setHexBank()로 수신 주소 설정, flushFeeNow()로 수동 플러시 가능
  - buyAmount(acceptTrade): 구매자가 원하는 수량만 거래, 나머지는 판매자 반환
  - Status: 0=OPEN, 1=TAKEN, 2=PAID, 3=RELEASED, 4=CANCELED, 5=DISPUTED, 6=RESOLVED
  - Fiat:   0=KRW, 1=VND
*/

interface IERC20 {
    function balanceOf(address) external view returns (uint256);
    function transfer(address, uint256) external returns (bool);
    function transferFrom(address, address, uint256) external returns (bool);
}

contract Ownable {
    address public owner;
    event OwnershipTransferred(address indexed prev, address indexed next);

    error NotOwner();
    error ZeroAddress();

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    constructor(address initialOwner) {
        if (initialOwner == address(0)) revert ZeroAddress();
        owner = initialOwner;
        emit OwnershipTransferred(address(0), initialOwner);
    }

    function transferOwnership(address next) external onlyOwner {
        if (next == address(0)) revert ZeroAddress();
        emit OwnershipTransferred(owner, next);
        owner = next;
    }
}

contract ReentrancyGuard {
    uint256 private _status = 1;
    error Reentrancy();
    modifier nonReentrant() {
        if (_status != 1) revert Reentrancy();
        _status = 2;
        _;
        _status = 1;
    }
}

contract vetEX is Ownable, ReentrancyGuard {
    // ---------- errors ----------
    error BadStatus();
    error NoTrade();
    error NotSeller();
    error NotBuyer();
    error NotParty();
    error TooEarly();
    error AmountZero();
    error FeeTooHigh();
    error ParamTooSmall();
    error NotArbitrator();
    error NothingToFlush();
    error HexBankNotSet();

    // ---------- trade struct ----------
    struct Trade {
        address seller;
        address buyer;
        uint256 amount;         // 에스크로 총량 (openTrade 시 잠금)
        uint256 buyAmount;      // 실제 구매 수량 (acceptTrade 시 설정)
        uint256 fiatAmount;     // 법정화폐 총액 (참고용)
        bytes32 paymentRef;
        uint64  createdAt;      // openTrade 시각
        uint64  takenAt;        // acceptTrade 시각 (timeout 기준)
        uint64  paidAt;         // markPaid 시각 (releaseGrace 기준)
        uint64  timeoutSeconds; // 광고 설정 타임아웃(초), 0이면 cancelGraceSeconds 사용
        uint8   fiat;           // 0=KRW, 1=VND
        uint8   status;
    }

    uint256 public nextTradeId = 1;
    mapping(uint256 => Trade) public trades;

    address public arbitrator;
    uint64  public releaseGraceSeconds = 6 hours;
    uint64  public cancelGraceSeconds  = 24 hours;

    // ---------- fee ----------
    uint16  public feeBps    = 50;      // 0.50%
    uint256 public pendingHexFee;       // 아직 hexBank로 미전송된 수수료
    uint256 public totalHexFeeCollected; // 누적 수수료 (리셋 없음)

    uint256 public constant FEE_FLUSH_THRESHOLD = 100e18; // 100 HEX

    // ---------- token / bank ----------
    IERC20  public hexToken;
    address public hexBank; // 수수료 자동 이체 대상 주소

    // ---------- events ----------
    event TradeOpened(uint256 indexed tradeId, address indexed seller, uint256 amount, uint8 fiat);
    event TradeTaken(uint256 indexed tradeId, address indexed buyer, uint256 buyAmount);
    event MarkedPaid(uint256 indexed tradeId, bytes32 paymentRef);
    event Released(uint256 indexed tradeId, uint256 toBuyer, uint256 toSeller, uint256 feeHex);
    event Canceled(uint256 indexed tradeId);
    event Disputed(uint256 indexed tradeId);
    event Resolved(uint256 indexed tradeId, address indexed winner);

    event ArbitratorChanged(address indexed prev, address indexed next);
    event HexBankChanged(address indexed prev, address indexed next);
    event ParamsChanged(uint64 releaseGrace, uint64 cancelGrace);
    event FeeConfigChanged(uint16 feeBps);

    // 수수료 적립 및 자동 플러시
    event FeeAccrued(uint256 indexed tradeId, uint256 feeHex, uint256 pending, uint256 totalCollected);
    event FeeFlushed(address indexed hexBank, uint256 amount, uint256 totalCollected);

    // ---------- constructor ----------
    constructor(
        address initialOwner,
        address initialArbitrator,
        address _hexToken,
        address _hexBank,
        uint16  _feeBps
    ) Ownable(initialOwner) {
        arbitrator = initialArbitrator;
        emit ArbitratorChanged(address(0), initialArbitrator);

        hexToken = IERC20(_hexToken);

        hexBank = _hexBank;
        emit HexBankChanged(address(0), _hexBank);

        _setFeeBps(_feeBps);
    }

    // ---------- internal helpers ----------
    function _t(address to, uint256 value) internal {
        if (value == 0) return;
        require(hexToken.transfer(to, value), "transfer fail");
    }

    function _calcFee(uint256 amt) internal view returns (uint256) {
        if (feeBps == 0) return 0;
        return (amt * uint256(feeBps)) / 10_000;
    }

    // pendingHexFee >= 100 HEX 이면 hexBank로 자동 이체 (best-effort)
    function _flushIfNeeded() internal {
        if (pendingHexFee < FEE_FLUSH_THRESHOLD) return;
        if (hexBank == address(0)) return;

        uint256 sendable = pendingHexFee;
        pendingHexFee = 0;

        _t(hexBank, sendable);
        emit FeeFlushed(hexBank, sendable, totalHexFeeCollected);
    }

    // ---------- admin ----------
    function setArbitrator(address next) external onlyOwner {
        emit ArbitratorChanged(arbitrator, next);
        arbitrator = next;
    }

    function setHexBank(address next) external onlyOwner {
        emit HexBankChanged(hexBank, next);
        hexBank = next;
    }

    function setParams(uint64 _releaseGrace, uint64 _cancelGrace) external onlyOwner {
        if (_releaseGrace < 5 minutes) revert ParamTooSmall();
        if (_cancelGrace  < 5 minutes) revert ParamTooSmall();
        releaseGraceSeconds = _releaseGrace;
        cancelGraceSeconds  = _cancelGrace;
        emit ParamsChanged(_releaseGrace, _cancelGrace);
    }

    function setFeeBps(uint16 _feeBps) external onlyOwner {
        _setFeeBps(_feeBps);
    }

    function _setFeeBps(uint16 _feeBps) internal {
        if (_feeBps > 2000) revert FeeTooHigh();
        feeBps = _feeBps;
        emit FeeConfigChanged(_feeBps);
    }

    // 수동 플러시 (오너 전용 — hexBank 미설정이거나 임계치 미달 시에도 강제 실행)
    function flushFeeNow(address to) external nonReentrant onlyOwner {
        if (pendingHexFee == 0) revert NothingToFlush();
        address dest = (to != address(0)) ? to : hexBank;
        if (dest == address(0)) revert HexBankNotSet();

        uint256 sendable = pendingHexFee;
        pendingHexFee = 0;

        _t(dest, sendable);
        emit FeeFlushed(dest, sendable, totalHexFeeCollected);
    }

    // ---------- trade flow ----------

    // 판매자: HEX approve 후 에스크로 개설
    function openTrade(
        uint256 amount,
        address buyer,          // 특정 구매자 지정 시, address(0)이면 누구나
        uint8   fiat,           // 0=KRW, 1=VND
        uint256 fiatAmount,
        bytes32 paymentRef,
        uint64  timeoutSeconds_ // 타임아웃(초), 0이면 cancelGraceSeconds 사용
    ) external nonReentrant returns (uint256 tradeId) {
        if (amount == 0) revert AmountZero();
        if (timeoutSeconds_ > 0 && timeoutSeconds_ < 5 minutes) revert ParamTooSmall();

        tradeId = nextTradeId++;
        Trade storage t = trades[tradeId];
        t.seller         = msg.sender;
        t.buyer          = buyer;
        t.amount         = amount;
        t.fiat           = fiat;
        t.fiatAmount     = fiatAmount;
        t.paymentRef     = paymentRef;
        t.timeoutSeconds = timeoutSeconds_ > 0 ? timeoutSeconds_ : uint64(cancelGraceSeconds);
        t.createdAt      = uint64(block.timestamp);
        t.status         = 0;

        require(hexToken.transferFrom(msg.sender, address(this), amount), "transferFrom fail");
        emit TradeOpened(tradeId, msg.sender, amount, fiat);
    }

    // 구매자: 원하는 수량으로 거래 신청
    function acceptTrade(uint256 tradeId, uint256 buyAmount) external {
        Trade storage t = trades[tradeId];
        if (t.seller == address(0)) revert NoTrade();
        if (t.status != 0) revert BadStatus();
        if (buyAmount == 0 || buyAmount > t.amount) revert AmountZero();

        if (t.buyer == address(0)) t.buyer = msg.sender;
        else if (t.buyer != msg.sender) revert NotBuyer();

        t.buyAmount = buyAmount;
        t.takenAt   = uint64(block.timestamp); // cancelGrace 기준 시각
        t.status    = 1;
        emit TradeTaken(tradeId, t.buyer, buyAmount);
    }

    // 구매자: 법정화폐 입금 완료 표시
    function markPaid(uint256 tradeId, bytes32 paymentRef) external {
        Trade storage t = trades[tradeId];
        if (t.seller == address(0)) revert NoTrade();
        if (t.buyer != msg.sender) revert NotBuyer();
        if (t.status != 1) revert BadStatus();

        t.status = 2;
        t.paidAt = uint64(block.timestamp);
        if (paymentRef != bytes32(0)) t.paymentRef = paymentRef;
        emit MarkedPaid(tradeId, t.paymentRef);
    }

    // 판매자: 입금 확인 후 HEX 이체
    // - buyAmount만 구매자에게 전송 (수수료 차감)
    // - 나머지(amount - buyAmount)는 판매자에게 반환
    // - 수수료 적립 후 >= 100 HEX 이면 hexBank로 자동 이체
    function release(uint256 tradeId) external nonReentrant {
        Trade storage t = trades[tradeId];
        if (t.seller == address(0)) revert NoTrade();
        if (t.seller != msg.sender) revert NotSeller();
        if (t.status != 2) revert BadStatus();

        t.status = 3;

        uint256 tradeAmt  = (t.buyAmount > 0 && t.buyAmount <= t.amount) ? t.buyAmount : t.amount;
        uint256 refundAmt = t.amount - tradeAmt;

        uint256 feeHex  = _calcFee(tradeAmt);
        if (feeHex >= tradeAmt) feeHex = 0; // 안전장치
        uint256 toBuyer = tradeAmt - feeHex;

        if (feeHex > 0) {
            pendingHexFee        += feeHex;
            totalHexFeeCollected += feeHex; // 누적 기록 (리셋 없음)
            emit FeeAccrued(tradeId, feeHex, pendingHexFee, totalHexFeeCollected);
        }

        _t(t.buyer, toBuyer);
        if (refundAmt > 0) _t(t.seller, refundAmt);

        emit Released(tradeId, toBuyer, refundAmt, feeHex);

        // 100 HEX 이상이면 hexBank로 자동 이체
        if (feeHex > 0) _flushIfNeeded();
    }

    // 판매자: 취소 (OPEN=즉시, TAKEN=타임아웃 이후)
    function cancelBySeller(uint256 tradeId) external nonReentrant {
        Trade storage t = trades[tradeId];
        if (t.seller == address(0)) revert NoTrade();
        if (t.seller != msg.sender) revert NotSeller();
        if (t.status != 0 && t.status != 1) revert BadStatus();

        if (t.status == 1) {
            uint64 grace = t.timeoutSeconds > 0 ? t.timeoutSeconds : cancelGraceSeconds;
            if (block.timestamp < uint256(t.takenAt) + uint256(grace)) revert TooEarly();
        }

        t.status = 4;
        _t(t.seller, t.amount);
        emit Canceled(tradeId);
    }

    // 구매자: 취소 (TAKEN=타임아웃 이후, 에스크로 HEX는 판매자에게 반환)
    function cancelByBuyer(uint256 tradeId) external nonReentrant {
        Trade storage t = trades[tradeId];
        if (t.seller == address(0)) revert NoTrade();
        if (t.buyer != msg.sender) revert NotBuyer();
        if (t.status != 1) revert BadStatus();

        uint64 grace = t.timeoutSeconds > 0 ? t.timeoutSeconds : cancelGraceSeconds;
        if (block.timestamp < uint256(t.takenAt) + uint256(grace)) revert TooEarly();

        t.status = 4;
        _t(t.seller, t.amount); // 에스크로 HEX → 판매자 반환
        emit Canceled(tradeId);
    }

    // 분쟁 신청 (판매자/구매자)
    function dispute(uint256 tradeId) external {
        Trade storage t = trades[tradeId];
        if (t.seller == address(0)) revert NoTrade();
        if (msg.sender != t.seller && msg.sender != t.buyer) revert NotParty();
        if (t.status != 1 && t.status != 2) revert BadStatus();

        if (t.status == 2 && msg.sender == t.buyer) {
            if (block.timestamp < uint256(t.paidAt) + uint256(releaseGraceSeconds)) revert TooEarly();
        }

        t.status = 5;
        emit Disputed(tradeId);
    }

    // 중재자: 분쟁 해결
    function resolveWinnerTakesAll(uint256 tradeId, address winner) external nonReentrant {
        if (msg.sender != arbitrator) revert NotArbitrator();
        Trade storage t = trades[tradeId];
        if (t.seller == address(0)) revert NoTrade();
        if (t.status != 5) revert BadStatus();
        if (winner != t.seller && winner != t.buyer) revert NotParty();

        t.status = 6;
        _t(winner, t.amount);
        emit Resolved(tradeId, winner);
    }

    // ---------- view ----------
    function getTrade(uint256 tradeId) external view returns (Trade memory) {
        return trades[tradeId];
    }
}
