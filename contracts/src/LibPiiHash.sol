// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {LibPoseidon2Yul} from "poseidon2-evm/bn254/yul/LibPoseidon2Yul.sol";
import {LibPoseidon2YulFull} from "./LibPoseidon2YulFull.sol";

// Sponge: identical to Noir rc.5 std::hash::poseidon2_permutation sponge
// and zkpassport/poseidon2 v0.6.2 (TS).
// IV = n << 64 in state[3]; absorb into lanes [0..2]; permute when full; final permute; output state[0].
// Hash2/hash3 delegate to LibPoseidon2Yul. Hash4/hash8 use LibPoseidon2YulFull multi-block sponge.
// All 7 golden vectors confirmed in Stage 0 gate.
/**
 * @title LibPiiHash
 * @notice Poseidon2 sponge wrappers for all arities used in Pii circuits (BN254, t=4, rate=3).
 */
library LibPiiHash {
    uint256 internal constant BN254_PRIME =
        0x30644e72e131a029b85045b68181585d2833e84879b9709143e1f593f0000001;

    // ── Primitive arities ────────────────────────────────────────────────────

    /// @notice hash2(a, b) — IV = 2<<64; single permutation.
    function hash2(uint256 a, uint256 b) internal pure returns (uint256) {
        return LibPoseidon2Yul.hash_2(a, b);
    }

    /// @notice hash3(a, b, c) — IV = 3<<64; single permutation.
    function hash3(uint256 a, uint256 b, uint256 c) internal pure returns (uint256) {
        return LibPoseidon2Yul.hash_3(a, b, c);
    }

    /// @notice hash4(a, b, c, d) — IV = 4<<64; two permutations.
    ///   Block 1: permute([a, b, c, IV])  -> [s0, s1, s2, s3]
    ///   Absorb d: s0 = (s0 + d) mod p
    ///   Squeeze:  permute([s0, s1, s2, s3]) -> output = r0
    function hash4(uint256 a, uint256 b, uint256 c, uint256 d) internal pure returns (uint256) {
        uint256 iv4 = 4 << 64;
        (uint256 s0, uint256 s1, uint256 s2, uint256 s3) =
            LibPoseidon2YulFull.poseidon2_full(a, b, c, iv4);
        s0 = addmod(s0, d, BN254_PRIME);
        (uint256 r0,,,) = LibPoseidon2YulFull.poseidon2_full(s0, s1, s2, s3);
        return r0;
    }

    /// @notice hash8(a..h) — IV = 8<<64; three permutations.
    ///   Block 1: permute([a, b, c, IV])     -> [s0,s1,s2,s3]
    ///   Block 2: permute([s0+d, s1+e, s2+f, s3]) -> [t0,t1,t2,t3]
    ///   Partial: t0 += g, t1 += h
    ///   Squeeze: permute([t0,t1,t2,t3])     -> output = r0
    function hash8(
        uint256 a,
        uint256 b,
        uint256 c,
        uint256 d,
        uint256 e,
        uint256 f,
        uint256 g,
        uint256 h
    ) internal pure returns (uint256) {
        uint256 iv8 = 8 << 64;

        // Block 1: absorb a,b,c at indices 0,1,2; permute
        (uint256 s0, uint256 s1, uint256 s2, uint256 s3) =
            LibPoseidon2YulFull.poseidon2_full(a, b, c, iv8);

        // Block 2: absorb d,e,f at indices 3,4,5 (mod 3 -> 0,1,2); permute
        s0 = addmod(s0, d, BN254_PRIME);
        s1 = addmod(s1, e, BN254_PRIME);
        s2 = addmod(s2, f, BN254_PRIME);
        (s0, s1, s2, s3) = LibPoseidon2YulFull.poseidon2_full(s0, s1, s2, s3);

        // Partial block: absorb g,h at indices 6,7 (mod 3 -> 0,1); no permute trigger
        s0 = addmod(s0, g, BN254_PRIME);
        s1 = addmod(s1, h, BN254_PRIME);

        // Final squeeze permutation
        (uint256 r0,,,) = LibPoseidon2YulFull.poseidon2_full(s0, s1, s2, s3);
        return r0;
    }

    // ── Pii protocol domain functions ────────────────────────────────────────

    /// @notice secret = hash2(owner_key, blinding)
    function piiSecret(uint256 ownerKey, uint256 blinding) internal pure returns (uint256) {
        return hash2(ownerKey, blinding);
    }

    /// @notice commitment = hash3(asset_id, amount, secret)
    ///   where secret = hash2(owner_key, blinding)
    function noteCommitment(uint256 assetId, uint256 amount, uint256 sec)
        internal
        pure
        returns (uint256)
    {
        return hash3(assetId, amount, sec);
    }

    /// @notice nullifier = hash2(commitment, spending_key)
    function piiNullifier(uint256 commitment, uint256 spendingKey)
        internal
        pure
        returns (uint256)
    {
        return hash2(commitment, spendingKey);
    }

    /// @notice orderCommitment = hash8(side, price, amount, asset_base, asset_quote, owner_key, nonce, expiry)
    ///   Field order per SPEC §2: side, price, amount, asset_base, asset_quote, owner_key, nonce, expiry.
    function orderCommitment(
        uint256 side,
        uint256 price,
        uint256 amount,
        uint256 assetBase,
        uint256 assetQuote,
        uint256 ownerKey,
        uint256 nonce,
        uint256 expiry
    ) internal pure returns (uint256) {
        return hash8(side, price, amount, assetBase, assetQuote, ownerKey, nonce, expiry);
    }
}
