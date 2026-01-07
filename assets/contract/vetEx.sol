// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/*
  vetEX (Escrow)
  - ERC20 escrow for USDT / HEX trades
  - USDT trade:
      * buyer receives amount - feeUsdt
      * feeUsdt accumulates in pendingUsdtFee (owner can withdraw)
  - HEX trade:
      * buyer receives amount - feeHex
      * feeHex remains in this contract and accumulates in pendingHexFee
      * if pendingHexFee > 10e18, auto flush on release():
          - transfer HEX to vetBank
          - call vetBank.totalfeeup(feeHexUploaded)
      * buyer also gets VET bonus (integer units):
          - VET bonus = feeHex / vetBank.price()
          - paid from this contract's VET inventory
  Assumptions:
    - HEX decimals: 18
    - USDT decimals: (your token) treated as base unit already in amount
    - VET decimals: 0 (integer)
    - vetBank.price(): HEX wei per 1 VET (0-decimal token)
*/

interface IERC20 {
    function balanceOf(address) external view returns (uint256);
    function transfer(address, uint256) external returns (bool);
    function transferFrom(address, address, uint256) external returns (bool);
}

interface IVetBank {
    function price() external view returns (uint256);     // HEX wei per 1 VET
    function totalfeeup(uint256 amount) external;         // record upload (HEX wei)
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
    error TokenZero();
    error AmountZero();
    error FeeTooHigh();
    error ParamTooSmall();
    error NotArbitrator();
    error FlushZero();
    error VetBankNotSet();
    error UsdtNotSet();

    // ---------- enums as uint8 ----------
    // Fiat: 0=KRW, 1=VND
    // Status: 0=OPEN,1=TAKEN,2=PAID,3=RELEASED,4=CANCELED,5=DISPUTED,6=RESOLVED

    struct Trade {
        address seller;
        address buyer;
        IERC20  token;
        uint256 amount;       // token base unit (HEX wei / USDT base unit)
        uint256 fiatAmount;
        bytes32 paymentRef;
        uint64  createdAt;
        uint64  paidAt;
        uint8   fiat;         // 0/1
        uint8   status;       // 0..6
    }

    uint256 public nextTradeId = 1;
    mapping(uint256 => Trade) public trades;

    address public arbitrator;
    uint64 public releaseGraceSeconds = 6 hours;
    uint64 public cancelGraceSeconds  = 24 hours;

    // ---------- fee config ----------
    uint16 public feeBps = 50; // 0.50%

    // ---------- token config ----------
    IERC20   public vetToken;   // VET (0 decimals)
    IERC20   public hexToken;   // HEX (18 decimals)
    IERC20   public usdtToken;  // USDT
    IVetBank public vetBank;    // price(), totalfeeup()

    // ---------- fee accumulators ----------
    uint256 public pendingUsdtFee; // USDT base unit
    uint256 public pendingHexFee;  // HEX wei

    uint256 public constant HEX_FEE_FLUSH_THRESHOLD = 10e18; // 10 HEX

    // ---------- events ----------
    event TradeOpened(uint256 indexed tradeId, address indexed seller, address token, uint256 amount, uint8 fiat);
    event TradeTaken(uint256 indexed tradeId, address indexed buyer);
    event MarkedPaid(uint256 indexed tradeId, bytes32 paymentRef);
    event Released(uint256 indexed tradeId, uint256 toBuyer, uint256 feeTaken);

    event Canceled(uint256 indexed tradeId);
    event Disputed(uint256 indexed tradeId);
    event Resolved(uint256 indexed tradeId);

    event ArbitratorChanged(address indexed prev, address indexed next);
    event ParamsChanged(uint64 releaseGraceSeconds, uint64 cancelGraceSeconds);

    event FeeConfigChanged(uint16 feeBps);
    event TokenConfigChanged(address usdtToken, address hexToken, address vetToken, address vetBank);

    event UsdtFeeAccrued(uint256 indexed tradeId, uint256 feeUsdt, uint256 pendingAfter);

    event HexFeeAccrued(uint256 indexed tradeId, uint256 feeHex, uint256 pendingAfter);
    event HexFeeFlushed(address indexed vetBank, uint256 amountHex, uint256 pendingAfter);

    event VetBonusPaid(uint256 indexed tradeId, address indexed buyer, uint256 feeHex, uint256 priceWei, uint256 vetBonus);
    event VetBonusSkipped(uint256 indexed tradeId, uint8 reason, uint256 feeHex, uint256 priceWei, uint256 needVet, uint256 curVet);
    // reason: 1=config-missing,2=not-hex-trade,3=fee-zero,4=price-zero,5=vet-zero,6=insufficient-vet

    // ---------- ctor ----------
    constructor(
        address initialOwner,
        address initialArbitrator,
        address _usdtToken,
        address _hexToken,
        address _vetToken,
        address _vetBank,
        uint16  _feeBps
    ) Ownable(initialOwner) {
        arbitrator = initialArbitrator;
        emit ArbitratorChanged(address(0), initialArbitrator);

        usdtToken = IERC20(_usdtToken);
        hexToken  = IERC20(_hexToken);
        vetToken  = IERC20(_vetToken);
        vetBank   = IVetBank(_vetBank);

        emit TokenConfigChanged(_usdtToken, _hexToken, _vetToken, _vetBank);

        _setFeeBps(_feeBps);
    }

    // ---------- internal token helpers ----------
    function _t(IERC20 token, address to, uint256 value) internal {
        if (value == 0) return;
        bool ok = token.transfer(to, value);
        require(ok, "transfer fail");
    }

    function _tf(IERC20 token, address from, address to, uint256 value) internal {
        bool ok = token.transferFrom(from, to, value);
        require(ok, "transferFrom fail");
    }

    // ---------- admin ----------
    function setArbitrator(address next) external onlyOwner {
        emit ArbitratorChanged(arbitrator, next);
        arbitrator = next;
    }

    function setParams(uint64 _releaseGraceSeconds, uint64 _cancelGraceSeconds) external onlyOwner {
        if (_releaseGraceSeconds < 5 minutes) revert ParamTooSmall();
        if (_cancelGraceSeconds < 5 minutes) revert ParamTooSmall();
        releaseGraceSeconds = _releaseGraceSeconds;
        cancelGraceSeconds = _cancelGraceSeconds;
        emit ParamsChanged(_releaseGraceSeconds, _cancelGraceSeconds);
    }

    function setFeeBps(uint16 _feeBps) external onlyOwner {
        _setFeeBps(_feeBps);
    }

    function _setFeeBps(uint16 _feeBps) internal {
        if (_feeBps > 2000) revert FeeTooHigh(); // 20% cap
        feeBps = _feeBps;
        emit FeeConfigChanged(_feeBps);
    }

    function setTokenConfig(address _usdtToken, address _hexToken, address _vetToken, address _vetBank) external onlyOwner {
        usdtToken = IERC20(_usdtToken);
        hexToken  = IERC20(_hexToken);
        vetToken  = IERC20(_vetToken);
        vetBank   = IVetBank(_vetBank);
        emit TokenConfigChanged(_usdtToken, _hexToken, _vetToken, _vetBank);
    }

    // ---------- fee calc ----------
    function _calcFee(uint256 tradeAmount) internal view returns (uint256) {
        if (feeBps == 0) return 0;
        return (tradeAmount * uint256(feeBps)) / 10_000;
    }

    // ---------- flush HEX fee to vetBank (best-effort helper) ----------
    function _flushHexIfNeeded() internal {
        if (pendingHexFee <= HEX_FEE_FLUSH_THRESHOLD) return;
        if (address(vetBank) == address(0)) return;

        uint256 curHex = hexToken.balanceOf(address(this));
        uint256 sendable = pendingHexFee;
        if (sendable > curHex) sendable = curHex;
        if (sendable == 0) return;

        pendingHexFee -= sendable;

        _t(hexToken, address(vetBank), sendable);
        // record upload (if this reverts, we must not revert release)
        try vetBank.totalfeeup(sendable) {
        } catch {
            // ignore
        }

        emit HexFeeFlushed(address(vetBank), sendable, pendingHexFee);
    }

    // ---------- HEX trade: VET bonus ----------
    function _tryPayVetBonus(uint256 tradeId, address buyer, uint256 feeHex) internal {
        if (address(vetToken) == address(0) || address(vetBank) == address(0)) {
            emit VetBonusSkipped(tradeId, 1, feeHex, 0, 0, vetToken.balanceOf(address(this)));
            return;
        }
        if (feeHex == 0) {
            emit VetBonusSkipped(tradeId, 3, 0, 0, 0, vetToken.balanceOf(address(this)));
            return;
        }

        uint256 p = vetBank.price();
        if (p == 0) {
            emit VetBonusSkipped(tradeId, 4, feeHex, 0, 0, vetToken.balanceOf(address(this)));
            return;
        }

        uint256 bonusVet = feeHex / p; // floor, VET is integer
        if (bonusVet == 0) {
            emit VetBonusSkipped(tradeId, 5, feeHex, p, 0, vetToken.balanceOf(address(this)));
            return;
        }

        uint256 curVet = vetToken.balanceOf(address(this));
        if (curVet < bonusVet) {
            emit VetBonusSkipped(tradeId, 6, feeHex, p, bonusVet, curVet);
            return;
        }

        _t(vetToken, buyer, bonusVet);
        emit VetBonusPaid(tradeId, buyer, feeHex, p, bonusVet);
    }

    // ---------- trade flow ----------
    function openTrade(
        address token,
        uint256 amount,
        address buyer,
        uint8 fiat,          // 0=KRW,1=VND
        uint256 fiatAmount,
        bytes32 paymentRef
    ) external nonReentrant returns (uint256 tradeId) {
        if (token == address(0)) revert TokenZero();
        if (amount == 0) revert AmountZero();

        tradeId = nextTradeId++;

        Trade storage t = trades[tradeId];
        t.seller = msg.sender;
        t.buyer = buyer;
        t.token = IERC20(token);
        t.amount = amount;
        t.fiat = fiat;
        t.fiatAmount = fiatAmount;
        t.paymentRef = paymentRef;
        t.createdAt = uint64(block.timestamp);
        t.status = 0;

        _tf(t.token, msg.sender, address(this), amount);
        emit TradeOpened(tradeId, msg.sender, token, amount, fiat);
    }

    function acceptTrade(uint256 tradeId) external {
        Trade storage t = trades[tradeId];
        if (t.seller == address(0)) revert NoTrade();
        if (t.status != 0) revert BadStatus();

        if (t.buyer == address(0)) t.buyer = msg.sender;
        else if (t.buyer != msg.sender) revert NotBuyer();

        t.status = 1;
        emit TradeTaken(tradeId, t.buyer);
    }

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

    // release:
    // USDT: buyer gets amount-feeUsdt, pendingUsdtFee += feeUsdt
    // HEX:  buyer gets amount-feeHex,  pendingHexFee  += feeHex, VET bonus based on feeHex, and auto flush if needed
    function release(uint256 tradeId) external nonReentrant {
        Trade storage t = trades[tradeId];
        if (t.seller == address(0)) revert NoTrade();
        if (t.seller != msg.sender) revert NotSeller();
        if (t.status != 2) revert BadStatus();

        t.status = 3;

        uint256 feeTaken = 0;
        uint256 toBuyer = t.amount;

        // USDT fee
        if (address(usdtToken) != address(0) && address(t.token) == address(usdtToken) && feeBps != 0) {
            uint256 feeUsdt = _calcFee(t.amount);
            if (feeUsdt > 0 && feeUsdt < t.amount) {
                feeTaken = feeUsdt;
                toBuyer = t.amount - feeUsdt;
                pendingUsdtFee += feeUsdt;
                emit UsdtFeeAccrued(tradeId, feeUsdt, pendingUsdtFee);
            }
        }

        // HEX fee (real: reduce buyer receive, keep fee inside contract)
        uint256 feeHex = 0;
        if (address(hexToken) != address(0) && address(t.token) == address(hexToken) && feeBps != 0) {
            feeHex = _calcFee(t.amount);
            if (feeHex > 0 && feeHex < t.amount) {
                toBuyer = t.amount - feeHex;       // 핵심: 99%만 매수자에게
                pendingHexFee += feeHex;           // 1%는 컨트랙트에 남김(실물)
                emit HexFeeAccrued(tradeId, feeHex, pendingHexFee);
            } else {
                feeHex = 0;
            }
        }

        // transfer to buyer
        _t(t.token, t.buyer, toBuyer);

        // if HEX: pay VET bonus based on feeHex
        if (feeHex > 0) {
            _tryPayVetBonus(tradeId, t.buyer, feeHex);
            // if pending > threshold, flush right now (best-effort)
            _flushHexIfNeeded();
        }

        emit Released(tradeId, toBuyer, feeTaken);
    }

    function cancelBySeller(uint256 tradeId) external nonReentrant {
        Trade storage t = trades[tradeId];
        if (t.seller == address(0)) revert NoTrade();
        if (t.seller != msg.sender) revert NotSeller();
        if (t.status != 0 && t.status != 1) revert BadStatus();

        if (t.status == 0) {
            if (block.timestamp < uint256(t.createdAt) + uint256(cancelGraceSeconds)) revert TooEarly();
        }

        t.status = 4;
        _t(t.token, t.seller, t.amount);
        emit Canceled(tradeId);
    }

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

    function resolveWinnerTakesAll(uint256 tradeId, address winner) external nonReentrant {
        if (msg.sender != arbitrator) revert NotArbitrator();
        Trade storage t = trades[tradeId];
        if (t.seller == address(0)) revert NoTrade();
        if (t.status != 5) revert BadStatus();
        if (winner != t.seller && winner != t.buyer) revert NotParty();

        t.status = 6;
        _t(t.token, winner, t.amount);
        emit Resolved(tradeId);
    }

    function getTrade(uint256 tradeId) external view returns (Trade memory) {
        return trades[tradeId];
    }

    // optional manual flush (owner)
    function flushHexFeeNow() external nonReentrant onlyOwner {
        if (pendingHexFee == 0) revert FlushZero();
        if (address(vetBank) == address(0)) revert VetBankNotSet();

        uint256 curHex = hexToken.balanceOf(address(this));
        uint256 sendable = pendingHexFee;
        if (sendable > curHex) sendable = curHex;
        if (sendable == 0) revert FlushZero();

        pendingHexFee -= sendable;

        _t(hexToken, address(vetBank), sendable);
        try vetBank.totalfeeup(sendable) {
        } catch {
            // ignore
        }

        emit HexFeeFlushed(address(vetBank), sendable, pendingHexFee);
    }
}
