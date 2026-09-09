// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {RialtoOracle} from "./RialtoOracle.sol";

/// @notice Supplies the rate a pool centres its liquidity on.
/// @dev token0 units per one token1 unit, scaled 1e18.
interface IRateSource {
    function rate() external view returns (uint256);
}

/// @notice Reads a live rate from {RialtoOracle}, refusing anything stale.
contract OracleRateSource is IRateSource {
    RialtoOracle public immutable oracle;
    bytes32 public immutable pair;
    uint256 public immutable maxAge;

    constructor(RialtoOracle oracle_, bytes32 pair_, uint256 maxAge_) {
        oracle = oracle_;
        pair = pair_;
        maxAge = maxAge_;
    }

    function rate() external view returns (uint256 r) {
        (r,) = oracle.getRate(pair, maxAge);
    }
}

/// @notice A constant rate.
///
/// @dev Fixed at 1e18, this turns {RialtoPool} into an ordinary Curve-style stableswap —
///      which is exactly what the FX venues currently on Arc are. That makes the comparison
///      in the test suite a fair one: the same invariant, the same fee, the same code path,
///      differing only in where the liquidity is centred. Any difference in LP outcome is
///      attributable to that and to nothing else.
contract FixedRateSource is IRateSource {
    uint256 public immutable fixedRate;

    constructor(uint256 rate_) {
        fixedRate = rate_;
    }

    function rate() external view returns (uint256) {
        return fixedRate;
    }
}
