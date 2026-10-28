// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import "forge-std/Test.sol";
import {LibPoseidon2} from "poseidon2-evm/bn254/solidity/LibPoseidon2.sol";
import {Field} from "poseidon2-evm/bn254/solidity/Field.sol";

/// @title Poseidon2GoldenVectorTest
/// @notice Stage 0 gate: Solidity Poseidon2 (zemse/poseidon2-evm, pure Solidity BN254)
///         must reproduce golden vectors generated from the same sponge in Noir.
///         Golden vectors were produced by the Noir sponge using std::hash::poseidon2_permutation
///         with t=4, rate=3, IV = message_size << 64, output = state[0].
///         zemse/poseidon2-evm uses the same construction (verified from LibPoseidon2.sol source).
///         If ANY assertion fails this is a hard blocker — do NOT proceed to Stage 1.

contract Poseidon2GoldenVectorTest is Test {
    using Field for Field.Type;

    // ── Golden vectors (from Noir nargo test --show-output, nargo 1.0.0-rc.5) ──
    // All values are the BN254 field element outputs, as uint256 (big-endian hex).

    uint256 constant GV_HASH2_1_2    = 0x038682aa1cb5ae4e0a3f13da432a95c77c5c111f6f030faf9cad641ce1ed7383;
    uint256 constant GV_HASH2_0_0    = 0x0b63a53787021a4a962a452c2921b3663aff1ffd8d5510540f8e659e782956f1;
    uint256 constant GV_HASH3_1_2_3  = 0x23864adb160dddf590f1d3303683ebcb914f828e2635f6e85a32f0a1aecd3dd8;
    uint256 constant GV_HASH4_1_2_3_4 = 0x130bf204a32cac1f0ace56c78b731aa3809f06df2731ebcf6b3464a15788b1b9;
    uint256 constant GV_HASH8_1_TO_8 = 0x01dec21c6e1b30609eda618d7e35e5d9d6152f8fa67320d939c1a89603647142;
    // zeros[1] = hash2(0, 0) — same as GV_HASH2_0_0
    uint256 constant GV_ZEROS_1      = 0x0b63a53787021a4a962a452c2921b3663aff1ffd8d5510540f8e659e782956f1;
    // zeros[20] = depth-20 empty Merkle tree root
    uint256 constant GV_EMPTY_TREE_ROOT = 0x1c8c3ca0b3a3d75850fcd4dc7bf1e3445cd0cfff3ca510630fd90b47e8a24755;

    // ── Helper: call LibPoseidon2 directly (pure, no deployment needed) ────────

    function solHash2(uint256 a, uint256 b) internal pure returns (uint256) {
        return Field.Type.unwrap(LibPoseidon2.hash_2(
            Field.Type.wrap(a),
            Field.Type.wrap(b)
        ));
    }

    function solHash3(uint256 a, uint256 b, uint256 c) internal pure returns (uint256) {
        return Field.Type.unwrap(LibPoseidon2.hash_3(
            Field.Type.wrap(a),
            Field.Type.wrap(b),
            Field.Type.wrap(c)
        ));
    }

    function solHash4(uint256 a, uint256 b, uint256 c, uint256 d) internal pure returns (uint256) {
        Field.Type[] memory inp = new Field.Type[](4);
        inp[0] = Field.Type.wrap(a);
        inp[1] = Field.Type.wrap(b);
        inp[2] = Field.Type.wrap(c);
        inp[3] = Field.Type.wrap(d);
        return Field.Type.unwrap(LibPoseidon2.hash(inp, 4, false));
    }

    function solHash8(
        uint256 a, uint256 b, uint256 c, uint256 d,
        uint256 e, uint256 f, uint256 g, uint256 h
    ) internal pure returns (uint256) {
        Field.Type[] memory inp = new Field.Type[](8);
        inp[0] = Field.Type.wrap(a); inp[1] = Field.Type.wrap(b);
        inp[2] = Field.Type.wrap(c); inp[3] = Field.Type.wrap(d);
        inp[4] = Field.Type.wrap(e); inp[5] = Field.Type.wrap(f);
        inp[6] = Field.Type.wrap(g); inp[7] = Field.Type.wrap(h);
        return Field.Type.unwrap(LibPoseidon2.hash(inp, 8, false));
    }

    function emptyTreeRoot() internal pure returns (uint256) {
        uint256 z = 0;
        for (uint256 i = 0; i < 20; i++) {
            z = solHash2(z, z);
        }
        return z;
    }

    // ── Tests ─────────────────────────────────────────────────────────────────

    function test_hash2_1_2() public pure {
        uint256 got = solHash2(1, 2);
        assertEq(got, GV_HASH2_1_2, "hash2(1,2) mismatch");
    }

    function test_hash2_0_0() public pure {
        uint256 got = solHash2(0, 0);
        assertEq(got, GV_HASH2_0_0, "hash2(0,0) mismatch");
    }

    function test_hash3_1_2_3() public pure {
        uint256 got = solHash3(1, 2, 3);
        assertEq(got, GV_HASH3_1_2_3, "hash3(1,2,3) mismatch");
    }

    function test_hash4_1_2_3_4() public pure {
        uint256 got = solHash4(1, 2, 3, 4);
        assertEq(got, GV_HASH4_1_2_3_4, "hash4(1,2,3,4) mismatch");
    }

    function test_hash8_1_to_8() public pure {
        uint256 got = solHash8(1, 2, 3, 4, 5, 6, 7, 8);
        assertEq(got, GV_HASH8_1_TO_8, "hash8(1..8) mismatch");
    }

    function test_zeros_1() public pure {
        uint256 got = solHash2(0, 0);
        assertEq(got, GV_ZEROS_1, "zeros[1] mismatch");
    }

    function test_empty_tree_root_depth20() public pure {
        uint256 got = emptyTreeRoot();
        assertEq(got, GV_EMPTY_TREE_ROOT, "depth-20 empty tree root mismatch");
    }

    // ── Gas measurements ──────────────────────────────────────────────────────

    function test_gas_hash2() public {
        uint256 g0 = gasleft();
        solHash2(1, 2);
        uint256 g1 = gasleft();
        console.log("REAL gas per hash2:", g0 - g1);
    }

    function test_gas_hash3() public {
        uint256 g0 = gasleft();
        solHash3(1, 2, 3);
        uint256 g1 = gasleft();
        console.log("REAL gas per hash3:", g0 - g1);
    }

    function test_gas_depth20_merkle_insert() public {
        // Simulate a single full depth-20 Merkle frontier insert (worst case: 20 hash2 calls)
        // zeros[] precomputed as constants (not computed here, so this measures just the hashing)
        uint256 leaf = 0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef;
        // precomputed zeros (depth-20 constant values from golden vectors)
        uint256[20] memory zeros;
        uint256 z = 0;
        for (uint256 i = 0; i < 20; i++) {
            zeros[i] = z;
            z = solHash2(z, z);
        }
        // Now measure: insert a leaf at index 0 (all frontier bits = 0, so 20 hash2 calls)
        uint256 g0 = gasleft();
        uint256 cur = leaf;
        for (uint256 lvl = 0; lvl < 20; lvl++) {
            // index bit = 0 at every level (first insert) → cur = hash2(cur, zeros[lvl])
            cur = solHash2(cur, zeros[lvl]);
        }
        uint256 g1 = gasleft();
        console.log("REAL gas for depth-20 Merkle insert (20x hash2):", g0 - g1);
        // prevent optimizer from eliminating cur
        assertGt(cur, 0);
    }
}
