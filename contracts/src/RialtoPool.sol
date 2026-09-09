// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IRateSource} from "./RateSource.sol";

interface IERC20 {
    function transfer(address to, uint256 amount) external returns (bool);
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
    function balanceOf(address account) external view returns (uint256);
    function decimals() external view returns (uint8);
}

/// @title  RialtoPool
/// @notice A stableswap whose liquidity is centred on the live FX rate, not on 1:1.
///
/// @dev The venues currently quoting USDC/EURC on Arc run a Curve-style stableswap, whose
///      invariant is flat — cheap — around equal balances, i.e. around a price of 1.00.
///      USDC/EURC has never traded at 1.00. It trades at EUR/USD. So the region those pools
///      make cheap is a price that does not occur, and the region where trading actually
///      happens is the steep part of the curve. Two consequences, both borne by the LP:
///      quoted slippage is worse than a constant-product pool would give, and every move in
///      EUR/USD hands the difference to an arbitrageur.
///
///      This pool applies the same invariant to *rate-scaled* balances. Token1's reserve is
///      expressed in token0 terms before the curve sees it, so the flat region sits on the
///      real rate and moves with it. The technique is Curve's own rate-provider mechanism;
///      what is new is having a rate to provide, which on Arc required building the oracle
///      first.
///
///      It generalises past EUR. Circle's partner stablecoins — BRL, MXN, JPY, ZAR, PHP —
///      trade at 5, 17, 150, 18 to the dollar. A 1:1 stableswap cannot hold them at all; a
///      rate-scaled one treats them exactly like EUR.
///
/// @dev SAFETY. Proportional withdrawal deliberately does not consult the rate source. If
///      the oracle stalls or its publishers go dark, swapping halts but every LP can still
///      take their share of the reserves out. A design where a dead oracle traps funds is
///      a worse design than one where it only stops trading.
contract RialtoPool {
    /*//////////////////////////////////////////////////////////////
                               CONSTANTS
    //////////////////////////////////////////////////////////////*/

    uint256 private constant N = 2;
    uint256 private constant PRECISION = 1e18;
    uint256 private constant FEE_DENOM = 1e6; // fees are parts per million
    uint256 private constant MAX_FEE_PPM = 100_000; // 10%, a ceiling not a target
    uint256 private constant MAX_LOOPS = 255;

    /// @notice Ceiling on the protocol's share of the swap fee.
    /// @dev Capped at half. An LP has to be able to see, from the code alone, that the
    ///      protocol cannot later vote itself the whole fee and leave them earning nothing.
    uint256 private constant MAX_PROTOCOL_SHARE_PPM = 500_000;

    /*//////////////////////////////////////////////////////////////
                                STORAGE
    //////////////////////////////////////////////////////////////*/

    IERC20 public immutable token0;
    IERC20 public immutable token1;
    IRateSource public immutable rateSource;

    /// @dev Multipliers lifting each token to 18 decimals. USDC and EURC are both 6.
    uint256 public immutable mul0;
    uint256 public immutable mul1;

    /// @notice Amplification coefficient. Higher means flatter around the centre.
    uint256 public immutable amp;

    /// @notice Swap fee in parts per million. 400 ppm = 4 bp.
    uint256 public immutable feePpm;

    /// @notice Share of the swap fee paid to {treasury}, in parts per million of the fee.
    /// @dev Taken out of the LP fee, never added on top: a trader's price is unchanged by
    ///      how the fee is split. 500_000 ppm sends half the fee to the protocol and leaves
    ///      half to the LPs.
    uint256 public protocolSharePpm;

    /// @notice Where the protocol's share accrues.
    address public treasury;

    /// @notice Protocol fees earned but not yet withdrawn, in token units.
    uint256 public protocolFees0;
    uint256 public protocolFees1;

    /// @notice Fee charged on the imbalanced portion of a deposit or withdrawal.
    /// @dev Curve's formula for n coins: fee * n / (4 * (n - 1)). Without it, depositing
    ///      lopsidedly and withdrawing proportionally is a free trade around the curve.
    uint256 public immutable imbalanceFeePpm;

    uint256 public reserve0;
    uint256 public reserve1;

    /*//////////////////////////////////////////////////////////////
                              LP TOKEN
    //////////////////////////////////////////////////////////////*/

    string public constant name = "Rialto LP";
    string public constant symbol = "RIALTO-LP";
    uint8 public constant decimals = 18;
    uint256 public totalSupply;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    event Transfer(address indexed from, address indexed to, uint256 value);
    event Approval(address indexed owner, address indexed spender, uint256 value);

    /*//////////////////////////////////////////////////////////////
                             EVENTS / ERRORS
    //////////////////////////////////////////////////////////////*/

    event Swap(address indexed sender, bool zeroForOne, uint256 amountIn, uint256 amountOut, uint256 rate);
    event LiquidityAdded(address indexed sender, uint256 amount0, uint256 amount1, uint256 lpMinted);
    event LiquidityRemoved(address indexed sender, uint256 amount0, uint256 amount1, uint256 lpBurned);
    event ProtocolFeeAccrued(bool isToken0, uint256 amount);
    event ProtocolFeesCollected(address indexed to, uint256 amount0, uint256 amount1);
    event TreasuryUpdated(address indexed from, address indexed to);
    event ProtocolShareUpdated(uint256 ppm);

    error BadFee();
    error BadAmp();
    error Reentrancy();
    error ZeroAmount();
    error Slippage();
    error NoConvergence();
    error InsufficientLiquidity();
    error TransferFailed();
    error BadRate();
    error NotTreasury();
    error ShareTooLarge();

    uint256 private _lock = 1;

    modifier nonReentrant() {
        if (_lock != 1) revert Reentrancy();
        _lock = 2;
        _;
        _lock = 1;
    }

    constructor(
        IERC20 t0,
        IERC20 t1,
        IRateSource rs,
        uint256 amp_,
        uint256 feePpm_,
        uint256 protocolSharePpm_,
        address treasury_
    ) {
        if (feePpm_ > MAX_FEE_PPM) revert BadFee();
        if (protocolSharePpm_ > MAX_PROTOCOL_SHARE_PPM) revert ShareTooLarge();
        if (amp_ == 0) revert BadAmp();
        protocolSharePpm = protocolSharePpm_;
        treasury = treasury_;
        token0 = t0;
        token1 = t1;
        rateSource = rs;
        amp = amp_;
        feePpm = feePpm_;
        // n = 2  =>  fee * 2 / 4  =>  fee / 2
        imbalanceFeePpm = (feePpm_ * N) / (4 * (N - 1));
        mul0 = 10 ** (18 - t0.decimals());
        mul1 = 10 ** (18 - t1.decimals());
    }

    /*//////////////////////////////////////////////////////////////
                            STABLESWAP MATH
    //////////////////////////////////////////////////////////////*/

    /// @dev The invariant D for two rate-scaled balances, by Newton's method.
    function _invariant(uint256 x, uint256 y) internal view returns (uint256) {
        uint256 s = x + y;
        if (s == 0) return 0;
        uint256 ann = amp * N;
        uint256 d = s;
        for (uint256 i; i < MAX_LOOPS; ++i) {
            uint256 dP = (((d * d) / (x * N)) * d) / (y * N);
            uint256 prev = d;
            d = ((ann * s + dP * N) * d) / ((ann - 1) * d + (N + 1) * dP);
            if (d > prev ? d - prev <= 1 : prev - d <= 1) return d;
        }
        revert NoConvergence();
    }

    /// @dev Given one rate-scaled balance and D, the other balance on the curve.
    function _otherBalance(uint256 x, uint256 d) internal view returns (uint256) {
        uint256 ann = amp * N;
        uint256 c = (((d * d) / (x * N)) * d) / (ann * N);
        uint256 b = x + d / ann;
        uint256 y = d;
        for (uint256 i; i < MAX_LOOPS; ++i) {
            uint256 prev = y;
            y = (y * y + c) / (2 * y + b - d);
            if (y > prev ? y - prev <= 1 : prev - y <= 1) return y;
        }
        revert NoConvergence();
    }

    /// @dev Reserves lifted to 18 decimals and expressed in token0 terms.
    function _scaled(uint256 r0, uint256 r1, uint256 rate) internal view returns (uint256 x, uint256 y) {
        x = r0 * mul0;
        y = (r1 * mul1 * rate) / PRECISION;
    }

    function _rate() internal view returns (uint256 r) {
        r = rateSource.rate();
        if (r == 0) revert BadRate();
    }

    /*//////////////////////////////////////////////////////////////
                                QUOTING
    //////////////////////////////////////////////////////////////*/

    /// @notice Output for a given input, fee included. Reverts if the rate is unusable.
    function quote(bool zeroForOne, uint256 amountIn) public view returns (uint256 amountOut) {
        (amountOut,) = _quote(zeroForOne, amountIn, _rate());
    }

    /// @dev Quote against a rate the caller has already read, so a swap consults the
    ///      oracle exactly once and cannot price against one rate then log another.
    /// @return amountOut   What the trader receives.
    /// @return protocolCut The protocol's share of the fee, in the output token. Split out
    ///         of the fee rather than added to it, so the trader's price does not depend on
    ///         how the fee is divided.
    function _quote(bool zeroForOne, uint256 amountIn, uint256 rate)
        internal
        view
        returns (uint256 amountOut, uint256 protocolCut)
    {
        if (amountIn == 0) revert ZeroAmount();
        (uint256 x, uint256 y) = _scaled(reserve0, reserve1, rate);
        if (x == 0 || y == 0) revert InsufficientLiquidity();
        uint256 d = _invariant(x, y);

        uint256 out18;
        uint256 mulOut;
        if (zeroForOne) {
            uint256 y1 = _otherBalance(x + amountIn * mul0, d);
            // Back out of token0 terms into token1 units.
            out18 = ((y - y1) * PRECISION) / rate;
            mulOut = mul1;
        } else {
            uint256 x1 = _otherBalance(y + (amountIn * mul1 * rate) / PRECISION, d);
            out18 = x - x1;
            mulOut = mul0;
        }
        uint256 fee18 = (out18 * feePpm) / FEE_DENOM;
        amountOut = (out18 - fee18) / mulOut;
        protocolCut = ((fee18 * protocolSharePpm) / FEE_DENOM) / mulOut;
    }

    /// @notice Input required to deliver exactly `amountOut` of the other token.
    ///
    /// @dev An invoice is denominated in what the payee receives — "pay me EUR 5,000" —
    ///      so settling one needs the inverse of a normal swap. Everything rounds against
    ///      the payer, because a rounding error that shorts the payee turns into an invoice
    ///      that is a cent underpaid, which is worse than a cent overcharged.
    function quoteExactOut(bool zeroForOne, uint256 amountOut) public view returns (uint256 amountIn) {
        (amountIn,) = _quoteExactOut(zeroForOne, amountOut, _rate());
    }

    function _quoteExactOut(bool zeroForOne, uint256 amountOut, uint256 rate)
        internal
        view
        returns (uint256 amountIn, uint256 protocolCut)
    {
        if (amountOut == 0) revert ZeroAmount();
        (uint256 x, uint256 y) = _scaled(reserve0, reserve1, rate);
        if (x == 0 || y == 0) revert InsufficientLiquidity();
        uint256 d = _invariant(x, y);

        uint256 mulOut = zeroForOne ? mul1 : mul0;
        uint256 net18 = amountOut * mulOut;
        // Gross up so that, after the fee, exactly `amountOut` is delivered.
        uint256 gross18 = _ceilDiv(net18 * FEE_DENOM, FEE_DENOM - feePpm);

        uint256 need;
        if (zeroForOne) {
            // Output is token1; express the withdrawal in token0 terms for the curve.
            uint256 outScaled = _ceilDiv(gross18 * rate, PRECISION);
            if (outScaled >= y) revert InsufficientLiquidity();
            need = _otherBalance(y - outScaled, d) - x;
            amountIn = _ceilDiv(need, mul0);
        } else {
            if (gross18 >= x) revert InsufficientLiquidity();
            uint256 y1 = _otherBalance(x - gross18, d);
            need = y1 - y;
            // Back out of token0 terms into token1 units.
            amountIn = _ceilDiv(need * PRECISION, rate * mul1);
        }

        uint256 fee18 = gross18 - net18;
        protocolCut = ((fee18 * protocolSharePpm) / FEE_DENOM) / mulOut;
    }

    /// @notice Marginal price of token1 in token0, scaled 1e18.
    /// @dev At balanced rate-scaled reserves this equals the oracle rate — which is the
    ///      whole point, and is asserted in the tests.
    function spotPrice() external view returns (uint256) {
        uint256 rate = _rate();
        (uint256 x, uint256 y) = _scaled(reserve0, reserve1, rate);
        if (x == 0 || y == 0) revert InsufficientLiquidity();
        uint256 d = _invariant(x, y);
        // Price by finite difference on a unit of token1.
        uint256 probe = 1e15; // 0.001 token1, in 18dp token0 terms after scaling
        uint256 y1 = y + (probe * rate) / PRECISION;
        uint256 x1 = _otherBalance(y1, d);
        return ((x - x1) * PRECISION) / probe;
    }

    /*//////////////////////////////////////////////////////////////
                                SWAPPING
    //////////////////////////////////////////////////////////////*/

    function swap(bool zeroForOne, uint256 amountIn, uint256 minAmountOut, address to)
        external
        nonReentrant
        returns (uint256 amountOut)
    {
        uint256 rate = _rate();
        uint256 protocolCut;
        (amountOut, protocolCut) = _quote(zeroForOne, amountIn, rate);
        if (amountOut < minAmountOut) revert Slippage();
        if (amountOut == 0) revert ZeroAmount();

        (IERC20 tIn, IERC20 tOut) = zeroForOne ? (token0, token1) : (token1, token0);
        _pull(tIn, msg.sender, amountIn);

        // The protocol's share leaves the reserves but stays in the contract until
        // collected, so it is never handed out to LPs on withdrawal.
        if (zeroForOne) {
            reserve0 += amountIn;
            reserve1 -= amountOut + protocolCut;
            protocolFees1 += protocolCut;
        } else {
            reserve1 += amountIn;
            reserve0 -= amountOut + protocolCut;
            protocolFees0 += protocolCut;
        }
        if (protocolCut != 0) emit ProtocolFeeAccrued(!zeroForOne, protocolCut);

        _push(tOut, to, amountOut);
        emit Swap(msg.sender, zeroForOne, amountIn, amountOut, rate);
    }

    /// @notice Swap so that exactly `amountOut` is delivered to `to`.
    ///
    /// @dev `maxAmountIn` is a bound, not a locked rate. A genuinely firm quote requires
    ///      somebody to warehouse the price risk between quoting and settling, which needs
    ///      a balance sheet this contract does not have and should not pretend to. A bound
    ///      plus a deadline is what can honestly be offered without one.
    function swapExactOut(bool zeroForOne, uint256 amountOut, uint256 maxAmountIn, address to)
        external
        nonReentrant
        returns (uint256 amountIn)
    {
        uint256 rate = _rate();
        uint256 protocolCut;
        (amountIn, protocolCut) = _quoteExactOut(zeroForOne, amountOut, rate);
        if (amountIn > maxAmountIn) revert Slippage();
        if (amountIn == 0) revert ZeroAmount();

        (IERC20 tIn, IERC20 tOut) = zeroForOne ? (token0, token1) : (token1, token0);
        _pull(tIn, msg.sender, amountIn);

        if (zeroForOne) {
            reserve0 += amountIn;
            reserve1 -= amountOut + protocolCut;
            protocolFees1 += protocolCut;
        } else {
            reserve1 += amountIn;
            reserve0 -= amountOut + protocolCut;
            protocolFees0 += protocolCut;
        }
        if (protocolCut != 0) emit ProtocolFeeAccrued(!zeroForOne, protocolCut);

        _push(tOut, to, amountOut);
        emit Swap(msg.sender, zeroForOne, amountIn, amountOut, rate);
    }

    /*//////////////////////////////////////////////////////////////
                               LIQUIDITY
    //////////////////////////////////////////////////////////////*/

    function addLiquidity(uint256 amount0, uint256 amount1, uint256 minLp, address to)
        external
        nonReentrant
        returns (uint256 lp)
    {
        if (amount0 == 0 && amount1 == 0) revert ZeroAmount();
        uint256 rate = _rate();
        uint256 n0 = reserve0 + amount0;
        uint256 n1 = reserve1 + amount1;

        if (totalSupply == 0) {
            (uint256 x1, uint256 y1) = _scaled(n0, n1, rate);
            if (x1 == 0 || y1 == 0) revert InsufficientLiquidity();
            lp = _invariant(x1, y1);
        } else {
            lp = _lpForDeposit(n0, n1, rate);
        }
        if (lp < minLp || lp == 0) revert Slippage();

        if (amount0 != 0) _pull(token0, msg.sender, amount0);
        if (amount1 != 0) _pull(token1, msg.sender, amount1);
        reserve0 = n0;
        reserve1 = n1;
        _mint(to, lp);
        emit LiquidityAdded(msg.sender, amount0, amount1, lp);
    }

    /// @dev LP owed for a deposit taking the pool from its current reserves to (n0, n1).
    ///
    ///      The imbalanced portion is charged a fee, so depositing lopsidedly and then
    ///      withdrawing proportionally is not a fee-free trade around the curve. The fee is
    ///      taken off the *accounting* balances only: the tokens stay in the pool, which is
    ///      what makes it accrue to the existing LPs rather than to nobody.
    function _lpForDeposit(uint256 n0, uint256 n1, uint256 rate) private view returns (uint256) {
        uint256 r0 = reserve0;
        uint256 r1 = reserve1;
        uint256 d0;
        uint256 d1;
        {
            (uint256 x0, uint256 y0) = _scaled(r0, r1, rate);
            d0 = _invariant(x0, y0);
            (uint256 x1, uint256 y1) = _scaled(n0, n1, rate);
            if (x1 == 0 || y1 == 0) revert InsufficientLiquidity();
            d1 = _invariant(x1, y1);
        }
        uint256 a0 = n0 - (_absDiff((d1 * r0) / d0, n0) * imbalanceFeePpm) / FEE_DENOM;
        uint256 a1 = n1 - (_absDiff((d1 * r1) / d0, n1) * imbalanceFeePpm) / FEE_DENOM;
        (uint256 x2, uint256 y2) = _scaled(a0, a1, rate);
        return (totalSupply * (_invariant(x2, y2) - d0)) / d0;
    }

    /// @notice Withdraw a proportional share of both reserves.
    /// @dev Intentionally free of any rate lookup: LPs can always exit, even with the
    ///      oracle down. Being proportional, it is also not a trade, so it needs no fee.
    function removeLiquidity(uint256 lp, uint256 minAmount0, uint256 minAmount1, address to)
        external
        nonReentrant
        returns (uint256 amount0, uint256 amount1)
    {
        if (lp == 0) revert ZeroAmount();
        uint256 supply = totalSupply;
        amount0 = (reserve0 * lp) / supply;
        amount1 = (reserve1 * lp) / supply;
        if (amount0 < minAmount0 || amount1 < minAmount1) revert Slippage();

        _burn(msg.sender, lp);
        reserve0 -= amount0;
        reserve1 -= amount1;
        if (amount0 != 0) _push(token0, to, amount0);
        if (amount1 != 0) _push(token1, to, amount1);
        emit LiquidityRemoved(msg.sender, amount0, amount1, lp);
    }

    /// @notice The pool's invariant, for LP accounting and tests.
    function invariant() external view returns (uint256) {
        (uint256 x, uint256 y) = _scaled(reserve0, reserve1, _rate());
        if (x == 0 || y == 0) return 0;
        return _invariant(x, y);
    }

    /// @notice Total reserve value in token0 terms at the current rate, 18 decimals.
    function totalValue() external view returns (uint256) {
        (uint256 x, uint256 y) = _scaled(reserve0, reserve1, _rate());
        return x + y;
    }

    /*//////////////////////////////////////////////////////////////
                            PROTOCOL REVENUE
    //////////////////////////////////////////////////////////////*/

    /// @notice Sweep accrued protocol fees to `to`.
    /// @dev Permissionless to call but only ever pays {treasury}, so a keeper can collect
    ///      without being trusted with the destination.
    function collectProtocolFees(address to) external nonReentrant returns (uint256 a0, uint256 a1) {
        if (to != treasury) revert NotTreasury();
        a0 = protocolFees0;
        a1 = protocolFees1;
        protocolFees0 = 0;
        protocolFees1 = 0;
        if (a0 != 0) _push(token0, to, a0);
        if (a1 != 0) _push(token1, to, a1);
        emit ProtocolFeesCollected(to, a0, a1);
    }

    function setTreasury(address to) external {
        if (msg.sender != treasury) revert NotTreasury();
        emit TreasuryUpdated(treasury, to);
        treasury = to;
    }

    /// @notice Adjust the protocol's share of the swap fee, up to the hard cap.
    function setProtocolShare(uint256 ppm) external {
        if (msg.sender != treasury) revert NotTreasury();
        if (ppm > MAX_PROTOCOL_SHARE_PPM) revert ShareTooLarge();
        protocolSharePpm = ppm;
        emit ProtocolShareUpdated(ppm);
    }

    /*//////////////////////////////////////////////////////////////
                            ERC20 (LP TOKEN)
    //////////////////////////////////////////////////////////////*/

    function approve(address spender, uint256 value) external returns (bool) {
        allowance[msg.sender][spender] = value;
        emit Approval(msg.sender, spender, value);
        return true;
    }

    function transfer(address to, uint256 value) external returns (bool) {
        _move(msg.sender, to, value);
        return true;
    }

    function transferFrom(address from, address to, uint256 value) external returns (bool) {
        uint256 a = allowance[from][msg.sender];
        if (a != type(uint256).max) allowance[from][msg.sender] = a - value;
        _move(from, to, value);
        return true;
    }

    function _move(address from, address to, uint256 value) private {
        balanceOf[from] -= value;
        unchecked { balanceOf[to] += value; }
        emit Transfer(from, to, value);
    }

    function _mint(address to, uint256 value) private {
        totalSupply += value;
        unchecked { balanceOf[to] += value; }
        emit Transfer(address(0), to, value);
    }

    function _burn(address from, uint256 value) private {
        balanceOf[from] -= value;
        unchecked { totalSupply -= value; }
        emit Transfer(from, address(0), value);
    }

    /*//////////////////////////////////////////////////////////////
                               INTERNAL
    //////////////////////////////////////////////////////////////*/

    function _absDiff(uint256 a, uint256 b) private pure returns (uint256) {
        return a > b ? a - b : b - a;
    }

    /// @dev Division that rounds up, so exact-output pricing never shorts the payee.
    function _ceilDiv(uint256 a, uint256 b) private pure returns (uint256) {
        return a == 0 ? 0 : (a - 1) / b + 1;
    }

    /// @dev Tolerates tokens that return nothing instead of a bool.
    function _pull(IERC20 t, address from, uint256 amount) private {
        (bool ok, bytes memory data) =
            address(t).call(abi.encodeWithSelector(IERC20.transferFrom.selector, from, address(this), amount));
        if (!ok || (data.length != 0 && !abi.decode(data, (bool)))) revert TransferFailed();
    }

    function _push(IERC20 t, address to, uint256 amount) private {
        (bool ok, bytes memory data) =
            address(t).call(abi.encodeWithSelector(IERC20.transfer.selector, to, amount));
        if (!ok || (data.length != 0 && !abi.decode(data, (bool)))) revert TransferFailed();
    }
}
