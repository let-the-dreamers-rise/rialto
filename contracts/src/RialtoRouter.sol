// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

interface IRialtoPool {
    function token0() external view returns (address);
    function token1() external view returns (address);
    function quoteExactOut(bool zeroForOne, uint256 amountOut) external view returns (uint256);
    function swapExactOut(bool zeroForOne, uint256 amountOut, uint256 maxAmountIn, address to)
        external
        returns (uint256);
}

interface IERC20 {
    function transfer(address to, uint256 amount) external returns (bool);
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
    function approve(address spender, uint256 amount) external returns (bool);
    function balanceOf(address account) external view returns (uint256);
}

/// @title  RialtoRouter
/// @notice Settle an invoice across currencies that share no pool.
///
/// @dev A Brazilian importer paying a Philippine supplier needs BRL→PHP. That pool will
///      never exist: liquidity for every ordered pair is N² pools, and nobody is going to
///      seed 56 of them. Routing through USDC turns the problem around — **N corridors give
///      N(N−1)/2 pairs.** Six pools is fifteen currency pairs; Circle's eight announced
///      partner stablecoins would be twenty-eight, from eight pools.
///
///      That is the whole argument for a router here, and it is why this is the piece that
///      makes the partner-stablecoin lineup useful rather than merely present.
///
/// @dev THE HARD PART. An invoice is denominated in what the payee receives, so a route has
///      to be solved *backwards*: to deliver exactly ₱5,000, first ask the PHP pool what
///      USDC it needs, then ask the BRL pool what BRL *that* costs. Only then is the
///      payer's number known. Each step is an exact-output solve through a stableswap
///      curve, and they compose because the hops touch different pools — executing the
///      first cannot move the second, so the backwards solve stays exact rather than
///      becoming an estimate. {NoRepeatedPool} enforces the precondition that makes that
///      true.
///
///      Rounding is against the payer at every hop, for the same reason as everywhere else:
///      an invoice a centavo short is a failed payment, an invoice a centavo over is a
///      rounding error.
///
/// @dev Non-custodial. Funds cross this contract only inside a single call, and the final
///      hop pays the payee directly rather than paying the router and forwarding.
contract RialtoRouter {
    /// @param pool       The venue for this leg.
    /// @param zeroForOne Direction through it: true spends token0 to obtain token1.
    struct Hop {
        address pool;
        bool zeroForOne;
    }

    /// @param path        Legs in payer→payee order.
    /// @param payee       Receives `amountOut` of the final currency.
    /// @param amountOut   Exactly what the payee receives.
    /// @param maxAmountIn The most the payer will part with, across the whole route.
    /// @param deadline    Unix seconds after which the instruction is void.
    /// @param invoiceRef  The payee's reference, carried through for reconciliation.
    struct Instruction {
        Hop[] path;
        address payee;
        uint256 amountOut;
        uint256 maxAmountIn;
        uint64 deadline;
        bytes32 invoiceRef;
    }

    event RoutedSettlement(
        bytes32 indexed invoiceRef,
        address indexed payer,
        address indexed payee,
        address tokenIn,
        address tokenOut,
        uint256 amountIn,
        uint256 amountOut,
        uint256 hops
    );

    uint256 public constant MAX_HOPS = 4;

    error EmptyPath();
    error TooManyHops();
    error NoRepeatedPool();
    error DisjointPath();
    error Expired();
    error ZeroPayee();
    error ZeroAmount();
    error TooExpensive(uint256 required, uint256 max);
    error ShortDelivery();
    error TransferFailed();
    error Reentrancy();

    uint256 private _lock = 1;

    modifier nonReentrant() {
        if (_lock != 1) revert Reentrancy();
        _lock = 2;
        _;
        _lock = 1;
    }

    /*//////////////////////////////////////////////////////////////
                                QUOTING
    //////////////////////////////////////////////////////////////*/

    function tokenIn(Hop memory h) public view returns (address) {
        return h.zeroForOne ? IRialtoPool(h.pool).token0() : IRialtoPool(h.pool).token1();
    }

    function tokenOut(Hop memory h) public view returns (address) {
        return h.zeroForOne ? IRialtoPool(h.pool).token1() : IRialtoPool(h.pool).token0();
    }

    /// @notice What the payer must supply for the payee to receive exactly `amountOut`.
    /// @dev Solved backwards from the payee. Reverts if the route is malformed, so a
    ///      caller quoting a bad path learns immediately rather than at settlement.
    function quoteExactOut(Hop[] calldata path, uint256 amountOut)
        public
        view
        returns (uint256 amountIn, uint256[] memory legOutputs)
    {
        _validate(path);
        if (amountOut == 0) revert ZeroAmount();

        uint256 n = path.length;
        legOutputs = new uint256[](n);
        legOutputs[n - 1] = amountOut;

        // Walk from the payee back toward the payer: each leg's required output is the
        // next leg's required input.
        for (uint256 i = n - 1; i > 0; --i) {
            legOutputs[i - 1] = IRialtoPool(path[i].pool).quoteExactOut(path[i].zeroForOne, legOutputs[i]);
        }
        amountIn = IRialtoPool(path[0].pool).quoteExactOut(path[0].zeroForOne, legOutputs[0]);
    }

    /*//////////////////////////////////////////////////////////////
                               SETTLEMENT
    //////////////////////////////////////////////////////////////*/

    /// @notice Settle a cross-currency invoice along `path`, atomically.
    function settle(Instruction calldata i) external nonReentrant returns (uint256 amountIn) {
        if (block.timestamp > i.deadline) revert Expired();
        if (i.payee == address(0)) revert ZeroPayee();

        uint256[] memory legOutputs;
        (amountIn, legOutputs) = quoteExactOut(i.path, i.amountOut);
        if (amountIn > i.maxAmountIn) revert TooExpensive(amountIn, i.maxAmountIn);

        uint256 n = i.path.length;
        address inTok = tokenIn(i.path[0]);
        address outTok = tokenOut(i.path[n - 1]);

        _pull(inTok, msg.sender, address(this), amountIn);

        uint256 carried = amountIn;
        for (uint256 h; h < n; ++h) {
            address legToken = tokenIn(i.path[h]);
            _approve(legToken, i.path[h].pool, carried);
            // The last hop pays the payee directly; the proceeds never rest here.
            address to = h == n - 1 ? i.payee : address(this);
            uint256 before = h == n - 1 ? IERC20(outTok).balanceOf(i.payee) : 0;

            IRialtoPool(i.path[h].pool).swapExactOut(i.path[h].zeroForOne, legOutputs[h], carried, to);

            if (h == n - 1 && IERC20(outTok).balanceOf(i.payee) - before < i.amountOut) {
                revert ShortDelivery();
            }
            carried = legOutputs[h];
        }

        emit RoutedSettlement(i.invoiceRef, msg.sender, i.payee, inTok, outTok, amountIn, i.amountOut, n);
    }

    /*//////////////////////////////////////////////////////////////
                               INTERNAL
    //////////////////////////////////////////////////////////////*/

    /// @dev A route is only solvable backwards if consecutive legs actually connect and no
    ///      pool appears twice. Repeating a pool would make the second solve depend on the
    ///      first leg's execution, turning an exact quote into a guess.
    function _validate(Hop[] calldata path) private view {
        uint256 n = path.length;
        if (n == 0) revert EmptyPath();
        if (n > MAX_HOPS) revert TooManyHops();

        for (uint256 i; i < n; ++i) {
            for (uint256 j = i + 1; j < n; ++j) {
                if (path[i].pool == path[j].pool) revert NoRepeatedPool();
            }
            if (i > 0 && tokenOut(path[i - 1]) != tokenIn(path[i])) revert DisjointPath();
        }
    }

    function _pull(address token, address from, address to, uint256 amount) private {
        (bool ok, bytes memory data) =
            token.call(abi.encodeWithSelector(IERC20.transferFrom.selector, from, to, amount));
        if (!ok || (data.length != 0 && !abi.decode(data, (bool)))) revert TransferFailed();
    }

    function _approve(address token, address spender, uint256 amount) private {
        (bool ok, bytes memory data) =
            token.call(abi.encodeWithSelector(IERC20.approve.selector, spender, amount));
        if (!ok || (data.length != 0 && !abi.decode(data, (bool)))) revert TransferFailed();
    }
}
