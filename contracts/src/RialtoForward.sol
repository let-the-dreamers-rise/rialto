// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

interface IRialtoOracle {
    function getRate(bytes32 pair, uint256 maxAge) external view returns (uint256 rate, uint64 observedAt);
}

interface IERC20 {
    function transfer(address to, uint256 amount) external returns (bool);
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
}

/// @title  RialtoForward
/// @notice Lock an FX rate for a future date, collateralised and cash-settled on-chain.
///
/// @dev An invoice has terms. "EUR 5,000, due in 30 days" means the payer learns what they
///      owe in their own currency thirty days after agreeing the price. Over thirty days
///      EUR/USD moves a percent or two, and the emerging-market corridors this is built for
///      move considerably more — BRL ranged 14% and TRY 17.8% over the year measured in
///      scripts/simulate-corridors.mjs.
///
///      Against that, being 25bp cheaper than a bank is noise. A business does not lie
///      awake over a quarter of a percent; it lies awake over the three percent it cannot
///      predict. Spot execution, however good, does not address this at all, and it is the
///      reason exporters accept terrible forward rates from banks: certainty is worth more
///      than price.
///
///      So this is the other half of the product. A payer with an invoice due in thirty
///      days locks the rate today against a writer who takes the other side, both sides
///      post collateral, and at maturity the difference is paid in USDC against the oracle.
///
/// @dev BOUNDED BY CONSTRUCTION. Payout is capped at the losing side's collateral, so
///      neither party can lose more than they posted and no position can go bad debt. That
///      is a deliberate trade: it makes the instrument a capped contract-for-difference
///      rather than a true forward, and a move past the collateral leaves the winner
///      under-compensated. The alternative — uncapped exposure with margin calls — needs a
///      liquidation engine and a keeper network to be safe, and would be dishonest to ship
///      as a first version. {liquidate} exists so a position that has run to its cap can be
///      closed early rather than sitting on a certain loss.
///
/// @dev WHAT THIS IS. A cash-settled derivative. It is more legally exposed than the spot
///      pools, which are plainly non-custodial software; a rate-lock has a stronger claim
///      to being a regulated product in most jurisdictions. The contracts are permissionless
///      and hold no discretion, but anyone deploying or operating a front end for this
///      should take advice first. The README says the same thing.
contract RialtoForward {
    /*//////////////////////////////////////////////////////////////
                                 TYPES
    //////////////////////////////////////////////////////////////*/

    /// @param pair       Oracle pair, e.g. keccak256("USD/BRL") as token0-per-token1.
    /// @param writer     Posts the offer and takes the short side of the local currency.
    /// @param notional   Size in local-currency units (6 decimals), the invoice amount.
    /// @param strike     Locked rate, token0 per token1, 1e18.
    /// @param maturity   Unix seconds at which it settles.
    /// @param collateral Writer's posted margin, in USDC units (6 decimals).
    /// @param taker      Zero until filled.
    struct Offer {
        bytes32 pair;
        address writer;
        address taker;
        uint256 notional;
        uint256 strike;
        uint64 maturity;
        uint256 writerCollateral;
        uint256 takerCollateral;
        bool settled;
        bool cancelled;
    }

    /*//////////////////////////////////////////////////////////////
                                STORAGE
    //////////////////////////////////////////////////////////////*/

    IERC20 public immutable usdc;
    IRialtoOracle public immutable oracle;

    /// @notice How stale a rate may be when settling. Tight: settlement is a payout.
    uint256 public constant SETTLE_MAX_AGE = 1 hours;

    /// @notice A position may be closed early once the loser's collateral is this close to
    ///         being exhausted, in basis points of that collateral.
    uint256 public constant LIQUIDATION_THRESHOLD_BPS = 9_000; // 90%

    /// @notice Grace period after maturity during which only the parties may settle.
    /// @dev After it lapses anyone may settle, so a position cannot be left open by a
    ///      counterparty who dislikes the outcome.
    uint256 public constant SETTLE_GRACE = 1 days;

    Offer[] private _offers;

    /*//////////////////////////////////////////////////////////////
                                 EVENTS
    //////////////////////////////////////////////////////////////*/

    event Offered(uint256 indexed id, address indexed writer, bytes32 indexed pair, uint256 notional, uint256 strike, uint64 maturity, uint256 collateral);
    event Cancelled(uint256 indexed id);
    event Taken(uint256 indexed id, address indexed taker, uint256 collateral);
    event Settled(uint256 indexed id, uint256 spot, int256 takerPnl, uint256 toTaker, uint256 toWriter, bool capped);
    event Liquidated(uint256 indexed id, address indexed by, uint256 spot);

    error ZeroAmount();
    error BadMaturity();
    error AlreadyTaken();
    error NotWriter();
    error NotParty();
    error AlreadySettled();
    error Cancelled_();
    error NotYetMature();
    error NotTaken();
    error TooEarly();
    error NotLiquidatable();
    error TransferFailed();
    error Reentrancy();

    uint256 private _lock = 1;

    modifier nonReentrant() {
        if (_lock != 1) revert Reentrancy();
        _lock = 2;
        _;
        _lock = 1;
    }

    constructor(IERC20 usdc_, IRialtoOracle oracle_) {
        usdc = usdc_;
        oracle = oracle_;
    }

    /*//////////////////////////////////////////////////////////////
                             OPENING A LOCK
    //////////////////////////////////////////////////////////////*/

    /// @notice Offer to write a forward: lock a rate for someone, and post margin for it.
    function offer(bytes32 pair, uint256 notional, uint256 strike, uint64 maturity, uint256 collateral)
        external
        nonReentrant
        returns (uint256 id)
    {
        if (notional == 0 || strike == 0 || collateral == 0) revert ZeroAmount();
        if (maturity <= block.timestamp) revert BadMaturity();

        _pull(msg.sender, collateral);
        _offers.push(Offer({
            pair: pair, writer: msg.sender, taker: address(0),
            notional: notional, strike: strike, maturity: maturity,
            writerCollateral: collateral, takerCollateral: 0,
            settled: false, cancelled: false
        }));
        id = _offers.length - 1;
        emit Offered(id, msg.sender, pair, notional, strike, maturity, collateral);
    }

    /// @notice Withdraw an unfilled offer.
    function cancel(uint256 id) external nonReentrant {
        Offer storage o = _offers[id];
        if (o.writer != msg.sender) revert NotWriter();
        if (o.taker != address(0)) revert AlreadyTaken();
        if (o.cancelled) revert Cancelled_();
        o.cancelled = true;
        uint256 refund = o.writerCollateral;
        o.writerCollateral = 0;
        emit Cancelled(id);
        _push(msg.sender, refund);
    }

    /// @notice Take the other side: lock the rate for your invoice.
    function take(uint256 id, uint256 collateral) external nonReentrant {
        Offer storage o = _offers[id];
        if (o.cancelled) revert Cancelled_();
        if (o.taker != address(0)) revert AlreadyTaken();
        if (block.timestamp >= o.maturity) revert BadMaturity();
        if (collateral == 0) revert ZeroAmount();

        _pull(msg.sender, collateral);
        o.taker = msg.sender;
        o.takerCollateral = collateral;
        emit Taken(id, msg.sender, collateral);
    }

    /*//////////////////////////////////////////////////////////////
                               SETTLEMENT
    //////////////////////////////////////////////////////////////*/

    /// @notice The taker's profit or loss at a given spot, in USDC units, uncapped.
    /// @dev The taker is long the local currency: they locked the price of what they must
    ///      buy. If it has become more expensive than the strike, the lock paid off.
    function pnlAt(uint256 id, uint256 spot) public view returns (int256) {
        Offer memory o = _offers[id];
        int256 diff = int256(spot) - int256(o.strike);
        return (diff * int256(o.notional)) / 1e18;
    }

    /// @notice Settle a matured position against the oracle.
    /// @dev Open to anyone once the grace period lapses, so a losing counterparty cannot
    ///      strand a position by declining to call it.
    function settle(uint256 id) external nonReentrant {
        Offer storage o = _offers[id];
        if (o.taker == address(0)) revert NotTaken();
        if (o.settled) revert AlreadySettled();
        if (block.timestamp < o.maturity) revert NotYetMature();
        if (block.timestamp < uint256(o.maturity) + SETTLE_GRACE && msg.sender != o.taker && msg.sender != o.writer) {
            revert NotParty();
        }

        (uint256 spot,) = oracle.getRate(o.pair, SETTLE_MAX_AGE);
        int256 pnl = pnlAt(id, spot);

        (uint256 toTaker, uint256 toWriter, bool capped) = _distribute(o, pnl);
        o.settled = true;
        uint256 tc = o.takerCollateral;
        uint256 wc = o.writerCollateral;
        o.takerCollateral = 0;
        o.writerCollateral = 0;
        require(toTaker + toWriter == tc + wc, "accounting");

        emit Settled(id, spot, pnl, toTaker, toWriter, capped);
        if (toTaker != 0) _push(o.taker, toTaker);
        if (toWriter != 0) _push(o.writer, toWriter);
    }

    /// @dev Split the pooled collateral according to the P&L, capped at what each side put
    ///      up. Capping is what makes bad debt impossible; the cost is that a move past the
    ///      collateral leaves the winner short, which {Settled}'s `capped` flag records.
    function _distribute(Offer memory o, int256 pnl)
        private
        pure
        returns (uint256 toTaker, uint256 toWriter, bool capped)
    {
        if (pnl >= 0) {
            uint256 win = uint256(pnl);
            if (win > o.writerCollateral) { win = o.writerCollateral; capped = true; }
            toTaker = o.takerCollateral + win;
            toWriter = o.writerCollateral - win;
        } else {
            uint256 loss = uint256(-pnl);
            if (loss > o.takerCollateral) { loss = o.takerCollateral; capped = true; }
            toTaker = o.takerCollateral - loss;
            toWriter = o.writerCollateral + loss;
        }
    }

    /// @notice Close a position early once one side's margin is nearly exhausted.
    /// @dev Without this a party whose collateral is spent sits on a certain loss until
    ///      maturity while the other carries counterparty risk for no further upside.
    ///      Settlement is at the current spot, which is what both sides would get anyway.
    function liquidate(uint256 id) external nonReentrant {
        Offer storage o = _offers[id];
        if (o.taker == address(0)) revert NotTaken();
        if (o.settled) revert AlreadySettled();

        (uint256 spot,) = oracle.getRate(o.pair, SETTLE_MAX_AGE);
        int256 pnl = pnlAt(id, spot);

        uint256 exposure = pnl >= 0 ? uint256(pnl) : uint256(-pnl);
        uint256 atRisk = pnl >= 0 ? o.writerCollateral : o.takerCollateral;
        if (exposure * 10_000 < atRisk * LIQUIDATION_THRESHOLD_BPS) revert NotLiquidatable();

        (uint256 toTaker, uint256 toWriter, bool capped) = _distribute(o, pnl);
        o.settled = true;
        o.takerCollateral = 0;
        o.writerCollateral = 0;

        emit Liquidated(id, msg.sender, spot);
        emit Settled(id, spot, pnl, toTaker, toWriter, capped);
        if (toTaker != 0) _push(o.taker, toTaker);
        if (toWriter != 0) _push(o.writer, toWriter);
    }

    /*//////////////////////////////////////////////////////////////
                                 VIEWS
    //////////////////////////////////////////////////////////////*/

    function offers() external view returns (uint256) { return _offers.length; }

    function get(uint256 id) external view returns (Offer memory) { return _offers[id]; }

    /// @notice How far spot can move against a side before its collateral is exhausted.
    /// @dev The number a treasurer actually wants: not "how much margin", but "how big a
    ///      move am I covered for".
    function coveredMoveBps(uint256 id) external view returns (uint256 takerSide, uint256 writerSide) {
        Offer memory o = _offers[id];
        if (o.notional == 0 || o.strike == 0) return (0, 0);
        // A 1bp move in spot is worth notional * strike * 1e-4 / 1e18 in USDC.
        uint256 perBp = (o.notional * o.strike) / 1e18 / 10_000;
        if (perBp == 0) return (type(uint256).max, type(uint256).max);
        return (o.takerCollateral / perBp, o.writerCollateral / perBp);
    }

    /*//////////////////////////////////////////////////////////////
                                INTERNAL
    //////////////////////////////////////////////////////////////*/

    function _pull(address from, uint256 amount) private {
        (bool ok, bytes memory data) =
            address(usdc).call(abi.encodeWithSelector(IERC20.transferFrom.selector, from, address(this), amount));
        if (!ok || (data.length != 0 && !abi.decode(data, (bool)))) revert TransferFailed();
    }

    function _push(address to, uint256 amount) private {
        (bool ok, bytes memory data) =
            address(usdc).call(abi.encodeWithSelector(IERC20.transfer.selector, to, amount));
        if (!ok || (data.length != 0 && !abi.decode(data, (bool)))) revert TransferFailed();
    }
}
