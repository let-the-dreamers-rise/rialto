// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @title  RialtoOracle
/// @notice A pull-based FX rate feed for Arc, verified on-chain from publisher signatures.
///
/// @dev Arc ships with no price oracle. That absence is why the FX venues on it price
///      USDC/EURC at 1:1 — without a rate you cannot centre a pool anywhere else. This is
///      the missing piece, and it is deliberately pull-based rather than push-based:
///
///      - **No keeper infrastructure.** A push feed needs someone paying gas to update a
///        price nobody may read. Here the rate is carried in by whoever needs it, in the
///        same transaction that uses it.
///      - **Fresh at the point of use.** A pushed price is as old as the last update. A
///        pulled price is as old as the caller allows, and the caller states that bound.
///      - **Cheap on a chain that charges in USDC.** Updates cost nothing until a trade
///        actually depends on one.
///
///      Prices are signed off-chain by a publisher set and require `quorum` distinct
///      signatures, so no single publisher can move the rate. Attestations are ordered by
///      observation time, not by arrival: a stale attestation that arrives late is ignored
///      rather than rewinding the feed.
contract RialtoOracle {
    /*//////////////////////////////////////////////////////////////
                                 TYPES
    //////////////////////////////////////////////////////////////*/

    /// @param pair       Identifier of the rate, e.g. keccak256("EUR/USD").
    /// @param rate       Quote units per base unit, scaled by 1e18. EUR/USD 1.08 => 1.08e18.
    /// @param observedAt Unix seconds at which the publisher observed the rate.
    struct Attestation {
        bytes32 pair;
        uint256 rate;
        uint64 observedAt;
    }

    struct Feed {
        uint256 rate;
        uint64 observedAt;
        uint64 postedAt;
    }

    /*//////////////////////////////////////////////////////////////
                                STORAGE
    //////////////////////////////////////////////////////////////*/

    bytes32 public immutable DOMAIN_SEPARATOR;

    bytes32 public constant ATTESTATION_TYPEHASH =
        keccak256("Attestation(bytes32 pair,uint256 rate,uint64 observedAt)");

    /// @notice Addresses whose signatures count toward quorum.
    mapping(address => bool) public isPublisher;

    /// @notice Signatures required for an attestation to be accepted.
    uint256 public immutable quorum;

    /// @notice Governance address able to rotate the publisher set.
    address public admin;

    /// @dev pair => latest accepted observation.
    mapping(bytes32 => Feed) private _feeds;

    /// @notice Move accepted in a single update when the previous observation is fresh.
    uint256 public constant MAX_DEVIATION_BPS = 1_000; // 10%

    /// @notice Timescale over which the accepted move widens.
    uint256 public constant DEVIATION_WINDOW = 1 hours;

    /// @notice Hard ceiling on any single update, however stale the previous one is.
    ///
    /// @dev This exists because the obvious circuit breaker is not one. Letting the cap
    ///      lapse entirely once the feed goes stale — so that a genuine gap move can get
    ///      through after a quiet weekend — hands a compromised publisher set a waiting
    ///      game: sit out the window, print any number at all, and drain the pools reading
    ///      the feed. Measured against a 2.33M USDC book, that was 878,700 USDC, or 37.8%
    ///      of the LPs' capital, from a single print.
    ///
    ///      So the allowance widens with staleness but never disappears. EUR/USD's largest
    ///      single-day move in modern history is a few percent; 25% is far outside anything
    ///      an FX market does and still bounds what a bad print is worth. A move genuinely
    ///      larger than this needs the publisher set to walk the rate there in steps, in
    ///      public, which is the point.
    uint256 public constant MAX_ABSOLUTE_DEVIATION_BPS = 2_500; // 25%

    /// @notice An attestation observed further ahead than this is rejected outright.
    uint256 public constant MAX_CLOCK_SKEW = 60;

    /*//////////////////////////////////////////////////////////////
                             EVENTS / ERRORS
    //////////////////////////////////////////////////////////////*/

    event RateUpdated(bytes32 indexed pair, uint256 rate, uint64 observedAt, uint256 signatures);
    event PublisherSet(address indexed publisher, bool allowed);
    event AdminTransferred(address indexed from, address indexed to);

    error NotAdmin();
    error BadQuorum();
    error ZeroRate();
    error FromFuture();
    error NotNewer();
    error QuorumNotMet();
    error UnsortedSigners();
    error DeviationTooLarge();
    error NoFeed();
    error StaleRate();
    error BadSignature();

    modifier onlyAdmin() {
        if (msg.sender != admin) revert NotAdmin();
        _;
    }

    constructor(address[] memory publishers, uint256 quorum_, address admin_) {
        if (quorum_ == 0 || quorum_ > publishers.length) revert BadQuorum();
        quorum = quorum_;
        admin = admin_;
        for (uint256 i; i < publishers.length; ++i) {
            isPublisher[publishers[i]] = true;
            emit PublisherSet(publishers[i], true);
        }
        DOMAIN_SEPARATOR = keccak256(
            abi.encode(
                keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
                keccak256(bytes("RialtoOracle")),
                keccak256(bytes("1")),
                block.chainid,
                address(this)
            )
        );
    }

    /*//////////////////////////////////////////////////////////////
                               PUBLISHING
    //////////////////////////////////////////////////////////////*/

    /// @notice EIP-712 digest a publisher signs.
    function digest(Attestation calldata a) public view returns (bytes32) {
        bytes32 structHash = keccak256(abi.encode(ATTESTATION_TYPEHASH, a.pair, a.rate, a.observedAt));
        return keccak256(abi.encodePacked("\x19\x01", DOMAIN_SEPARATOR, structHash));
    }

    /// @notice Post a signed rate. Anyone may relay; only publisher signatures count.
    /// @param sigs 65-byte signatures, those from publishers ordered by ascending signer
    ///        address. The ordering requirement is what makes duplicate-signer detection
    ///        O(n) instead of O(n²) — without it, one publisher could sign n times and fake
    ///        a quorum. Signatures from non-publishers are ignored rather than rejected, so
    ///        a relayer may forward everything it received without pre-filtering.
    function submit(Attestation calldata a, bytes[] calldata sigs) public {
        if (a.rate == 0) revert ZeroRate();
        if (a.observedAt > block.timestamp + MAX_CLOCK_SKEW) revert FromFuture();

        Feed memory prev = _feeds[a.pair];
        // Order by observation time, not arrival: a late-arriving stale attestation must
        // not rewind the feed.
        if (prev.observedAt != 0 && a.observedAt <= prev.observedAt) revert NotNewer();

        bytes32 d = digest(a);
        address last;
        uint256 counted;
        for (uint256 i; i < sigs.length; ++i) {
            address signer = _recover(d, sigs[i]);
            // Ordering is enforced only among signatures that actually count. A forged or
            // wrong-domain signature recovers to an arbitrary address, which is simply not
            // a publisher: it gets ignored and the call fails for the honest reason
            // (QuorumNotMet) rather than for an incidental one about sort order.
            if (isPublisher[signer]) {
                if (signer <= last) revert UnsortedSigners(); // equal => same publisher twice
                last = signer;
                ++counted;
            }
        }
        if (counted < quorum) revert QuorumNotMet();

        if (prev.rate != 0) {
            uint256 diff = a.rate > prev.rate ? a.rate - prev.rate : prev.rate - a.rate;
            if (diff * 10_000 > prev.rate * _allowedDeviationBps(block.timestamp - prev.observedAt)) {
                revert DeviationTooLarge();
            }
        }

        _feeds[a.pair] = Feed({rate: a.rate, observedAt: a.observedAt, postedAt: uint64(block.timestamp)});
        emit RateUpdated(a.pair, a.rate, a.observedAt, counted);
    }

    /*//////////////////////////////////////////////////////////////
                                READING
    //////////////////////////////////////////////////////////////*/

    /// @notice Latest rate for a pair, reverting if older than `maxAge` seconds.
    /// @dev The caller states its own tolerance. A pool settling a trade wants seconds; a
    ///      dashboard can accept minutes. A feed that picks one bound for everybody is
    ///      either too strict to use or too loose to trust.
    function getRate(bytes32 pair, uint256 maxAge) external view returns (uint256 rate, uint64 observedAt) {
        Feed memory f = _feeds[pair];
        if (f.rate == 0) revert NoFeed();
        if (block.timestamp > uint256(f.observedAt) + maxAge) revert StaleRate();
        return (f.rate, f.observedAt);
    }

    /// @notice Latest rate with no freshness check. For display, never for settlement.
    function peek(bytes32 pair) external view returns (Feed memory) {
        return _feeds[pair];
    }

    /// @notice Post a rate and read it back in one call, for pull-based consumers.
    function submitAndGet(Attestation calldata a, bytes[] calldata sigs, uint256 maxAge)
        external
        returns (uint256 rate, uint64 observedAt)
    {
        submit(a, sigs);
        Feed memory f = _feeds[a.pair];
        if (block.timestamp > uint256(f.observedAt) + maxAge) revert StaleRate();
        return (f.rate, f.observedAt);
    }

    /// @notice How large a move is accepted, given how stale the previous observation is.
    /// @dev Linear in staleness from {MAX_DEVIATION_BPS}, hard-capped at
    ///      {MAX_ABSOLUTE_DEVIATION_BPS}. Public so anyone relying on the feed can see
    ///      exactly how far one bad print could move it.
    function allowedDeviationBps(uint256 stalenessSeconds) external pure returns (uint256) {
        return _allowedDeviationBps(stalenessSeconds);
    }

    function _allowedDeviationBps(uint256 stalenessSeconds) private pure returns (uint256) {
        uint256 allowed = MAX_DEVIATION_BPS + (MAX_DEVIATION_BPS * stalenessSeconds) / DEVIATION_WINDOW;
        return allowed > MAX_ABSOLUTE_DEVIATION_BPS ? MAX_ABSOLUTE_DEVIATION_BPS : allowed;
    }

    /*//////////////////////////////////////////////////////////////
                              GOVERNANCE
    //////////////////////////////////////////////////////////////*/

    function setPublisher(address publisher, bool allowed) external onlyAdmin {
        isPublisher[publisher] = allowed;
        emit PublisherSet(publisher, allowed);
    }

    function transferAdmin(address to) external onlyAdmin {
        emit AdminTransferred(admin, to);
        admin = to;
    }

    /*//////////////////////////////////////////////////////////////
                               INTERNAL
    //////////////////////////////////////////////////////////////*/

    /// @dev Recover an ECDSA signer, rejecting the malleable upper-half-order form.
    function _recover(bytes32 d, bytes calldata sig) private pure returns (address) {
        if (sig.length != 65) revert BadSignature();
        bytes32 r;
        bytes32 s;
        uint8 v;
        assembly {
            r := calldataload(sig.offset)
            s := calldataload(add(sig.offset, 32))
            v := byte(0, calldataload(add(sig.offset, 64)))
        }
        if (v < 27) v += 27;
        if (uint256(s) > 0x7FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF5D576E7357A4501DDFE92F46681B20A0) {
            revert BadSignature();
        }
        address signer = ecrecover(d, v, r, s);
        if (signer == address(0)) revert BadSignature();
        return signer;
    }
}
