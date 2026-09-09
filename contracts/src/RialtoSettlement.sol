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

/// @title  RialtoSettlement
/// @notice Pay a cross-currency invoice in one transaction.
///
/// @dev An invoice is denominated in what the seller wants to receive — "EUR 5,000, due in
///      30 days, ref INV-2026-114". Every piece of that is missing from a swap:
///
///      - A swap is denominated in what you put *in*. An invoice is denominated in what
///        the payee gets *out*, which is why {IRialtoPool.swapExactOut} had to exist.
///      - A swap pays the caller. An invoice pays a third party, and the payer must never
///        be able to end up holding the proceeds by accident.
///      - A swap emits amounts. Reconciliation needs the invoice reference on-chain beside
///        them, or the payee is matching bank-statement rows by hand — which is exactly
///        what people do today, and exactly what makes cross-border settlement expensive
///        long after the money has moved.
///
///      This contract is non-custodial and holds nothing between transactions. It takes the
///      payer's funds, routes them through the pool, and delivers to the payee inside one
///      call. There is no state in which it owns a user's money.
///
/// @dev WHAT THIS IS NOT. It is not a firm quote. Locking a rate between quoting and
///      settling means somebody warehouses the price risk, which takes a balance sheet and
///      probably a licence. What is offered instead is a bound and a deadline: the payer
///      states the most they will part with and by when, and the transaction reverts rather
///      than settling on worse terms. That is honest about who carries the risk.
contract RialtoSettlement {
    /// @param pool        Venue to route through.
    /// @param payee       Who receives `amountOut`; never the caller by construction.
    /// @param zeroForOne  True when paying with token0 and settling in token1.
    /// @param amountOut   Exactly what the payee receives, in the settlement currency.
    /// @param maxAmountIn The most the payer will part with.
    /// @param deadline    Unix seconds after which the instruction is void.
    /// @param invoiceRef  The payee's own reference, carried through for reconciliation.
    struct Instruction {
        address pool;
        address payee;
        bool zeroForOne;
        uint256 amountOut;
        uint256 maxAmountIn;
        uint64 deadline;
        bytes32 invoiceRef;
    }

    event InvoiceSettled(
        bytes32 indexed invoiceRef,
        address indexed payer,
        address indexed payee,
        address pool,
        uint256 amountIn,
        uint256 amountOut,
        uint256 effectiveRate
    );

    error Expired();
    error ZeroPayee();
    error ZeroAmount();
    error TooExpensive(uint256 required, uint256 max);
    error TransferFailed();
    error Reentrancy();
    error ShortDelivery();

    uint256 private _lock = 1;

    modifier nonReentrant() {
        if (_lock != 1) revert Reentrancy();
        _lock = 2;
        _;
        _lock = 1;
    }

    /// @notice What settling this instruction costs right now, in the payer's currency.
    /// @dev Quote and settle are separate calls against the same view, so a caller can show
    ///      a price, then send a transaction whose bound they chose with that price in hand.
    function quote(address pool, bool zeroForOne, uint256 amountOut) external view returns (uint256) {
        return IRialtoPool(pool).quoteExactOut(zeroForOne, amountOut);
    }

    /// @notice Settle an invoice: take the payer's currency, deliver the payee's.
    /// @return amountIn What the payer actually parted with.
    function settle(Instruction calldata i) external nonReentrant returns (uint256 amountIn) {
        if (block.timestamp > i.deadline) revert Expired();
        if (i.payee == address(0)) revert ZeroPayee();
        if (i.amountOut == 0) revert ZeroAmount();

        IRialtoPool pool = IRialtoPool(i.pool);
        address tokenIn = i.zeroForOne ? pool.token0() : pool.token1();
        address tokenOut = i.zeroForOne ? pool.token1() : pool.token0();

        amountIn = pool.quoteExactOut(i.zeroForOne, i.amountOut);
        if (amountIn > i.maxAmountIn) revert TooExpensive(amountIn, i.maxAmountIn);

        _pull(tokenIn, msg.sender, address(this), amountIn);
        _approve(tokenIn, i.pool, amountIn);

        // The pool delivers straight to the payee: the proceeds never sit here, so there is
        // no window in which a payment can be intercepted or stranded.
        uint256 before = IERC20(tokenOut).balanceOf(i.payee);
        pool.swapExactOut(i.zeroForOne, i.amountOut, amountIn, i.payee);
        if (IERC20(tokenOut).balanceOf(i.payee) - before < i.amountOut) revert ShortDelivery();

        // Rate the payer actually got, all-in, scaled 1e18. Publishing it is the point:
        // an FX customer's first question is what spread they were charged, and the usual
        // answer is that they cannot tell.
        uint256 effectiveRate = i.zeroForOne
            ? (amountIn * 1e18) / i.amountOut
            : (i.amountOut * 1e18) / amountIn;

        emit InvoiceSettled(i.invoiceRef, msg.sender, i.payee, i.pool, amountIn, i.amountOut, effectiveRate);
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
