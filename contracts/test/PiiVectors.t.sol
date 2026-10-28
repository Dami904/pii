// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import "forge-std/Test.sol";
import {LibPiiHash} from "../src/LibPiiHash.sol";
import {PiiMerkle} from "../src/PiiMerkle.sol";

// ─────────────────────────────────────────────────────────────────────────────
// Minimal concrete subclass so we can exercise the abstract PiiMerkle
// ─────────────────────────────────────────────────────────────────────────────
contract PiiMerkleHarness is PiiMerkle {
    function insert(uint256 commitment) external returns (uint256 idx, uint256 root) {
        return _insert(commitment);
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// PiiVectorsTest — SPEC §2 golden-vector gate + Merkle root-history + gas
// ─────────────────────────────────────────────────────────────────────────────
contract PiiVectorsTest is Test {

    // ── Golden vectors from SPEC §2 ──────────────────────────────────────────

    uint256 constant GV_HASH2_1_2   = 0x038682aa1cb5ae4e0a3f13da432a95c77c5c111f6f030faf9cad641ce1ed7383;
    uint256 constant GV_HASH2_0_0   = 0x0b63a53787021a4a962a452c2921b3663aff1ffd8d5510540f8e659e782956f1;
    uint256 constant GV_HASH3_1_2_3 = 0x23864adb160dddf590f1d3303683ebcb914f828e2635f6e85a32f0a1aecd3dd8;
    uint256 constant GV_HASH4_1_4   = 0x130bf204a32cac1f0ace56c78b731aa3809f06df2731ebcf6b3464a15788b1b9;
    uint256 constant GV_HASH8_1_8   = 0x01dec21c6e1b30609eda618d7e35e5d9d6152f8fa67320d939c1a89603647142;

    // SPEC §2: ZERO_VALUE = keccak256("pii-shielded-pool-v1") mod r
    uint256 constant GV_ZERO_VALUE  = 0x10aa41cd532efb9f2b7337c3f588d65e4af1b6c5bc76a7faa5db259c06ec2466;

    // SPEC §2: empty root uses zeros[0]=ZERO_VALUE, zeros[i]=hash2(zeros[i-1],zeros[i-1])
    uint256 constant GV_EMPTY_ROOT  = 0x19ee29beb37701dd87b245c58cc348522c86f063f3aa049d19d6fddc71de23c7;

    // SPEC §2: owner_key(sk) = hash2(sk, 0); owner_key(7)
    uint256 constant GV_OWNER_KEY_7 = 0x0b0f697117aa52458ddd243aeeac42e2a58175474f8889f3d763521eea2ce64b;

    // SPEC §2: note commitment hash3(asset_id=5, amount=1000, secret=hash2(owner_key(7), blinding=999))
    uint256 constant GV_NOTE_CMT    = 0x0c91a967c6efc9312a70afc4e9da7a96849449459ab6e1e9f023162a0ee5f360;

    // SPEC §2: nullifier = hash2(commitment, sk=7)
    uint256 constant GV_NULLIFIER   = 0x1153d7217f751902fd027cab215bcc2ee93bec902ee4e0f557a7e5cbaab99788;

    // SPEC §2: order hash8(side=0, price=2e7, amount=10, asset_base=5, asset_quote=6, owner_key(7), nonce=42, expiry=1800000000)
    uint256 constant GV_ORDER_CMT   = 0x2e41f6b075f636c0b7ac654984c605f2b6119c600c1aacffc96f7b49c760ec42;

    PiiMerkleHarness merkle;

    function setUp() public {
        merkle = new PiiMerkleHarness();
    }

    // ────────────────────────────────────────────────────────────────────────
    // §A  Primitive hash vectors
    // ────────────────────────────────────────────────────────────────────────

    function test_hash2_1_2() public pure {
        assertEq(LibPiiHash.hash2(1, 2), GV_HASH2_1_2, "hash2(1,2)");
    }

    function test_hash2_0_0() public pure {
        assertEq(LibPiiHash.hash2(0, 0), GV_HASH2_0_0, "hash2(0,0)");
    }

    function test_hash3_1_2_3() public pure {
        assertEq(LibPiiHash.hash3(1, 2, 3), GV_HASH3_1_2_3, "hash3(1,2,3)");
    }

    function test_hash4_1_2_3_4() public pure {
        assertEq(LibPiiHash.hash4(1, 2, 3, 4), GV_HASH4_1_4, "hash4(1,2,3,4)");
    }

    function test_hash8_1_to_8() public pure {
        assertEq(LibPiiHash.hash8(1, 2, 3, 4, 5, 6, 7, 8), GV_HASH8_1_8, "hash8(1..8)");
    }

    // ────────────────────────────────────────────────────────────────────────
    // §B  ZERO_VALUE and empty tree root
    // ────────────────────────────────────────────────────────────────────────

    function test_ZERO_VALUE_constant() public pure {
        // Verify the constant matches keccak256("pii-shielded-pool-v1") mod r at compile time.
        uint256 r = 0x30644e72e131a029b85045b68181585d2833e84879b9709143e1f593f0000001;
        uint256 computed = uint256(keccak256("pii-shielded-pool-v1")) % r;
        assertEq(computed, GV_ZERO_VALUE, "ZERO_VALUE mismatch");
    }

    function test_ZERO_VALUE_from_contract() public view {
        assertEq(merkle.ZERO_VALUE(), GV_ZERO_VALUE, "PiiMerkle.ZERO_VALUE");
    }

    function test_empty_root() public view {
        assertEq(merkle.emptyRoot(), GV_EMPTY_ROOT, "empty tree root (depth-20)");
    }

    function test_zeros_0_eq_ZERO_VALUE() public view {
        assertEq(merkle.zeros(0), GV_ZERO_VALUE, "zeros[0] == ZERO_VALUE");
    }

    function test_empty_root_is_known() public view {
        assertTrue(merkle.isKnownRoot(GV_EMPTY_ROOT), "empty root must be known");
    }

    // ────────────────────────────────────────────────────────────────────────
    // §C  Protocol domain functions (key, note, nullifier, order)
    // ────────────────────────────────────────────────────────────────────────

    function test_owner_key_7() public pure {
        // owner_key(sk) = hash2(sk, 0)
        uint256 ok = LibPiiHash.hash2(7, 0);
        assertEq(ok, GV_OWNER_KEY_7, "owner_key(7)");
    }

    function test_note_commitment() public pure {
        // SPEC §2: commitment = hash3(asset_id, amount, secret)
        //           secret    = hash2(owner_key, blinding)
        // Params: asset_id=5, amount=1000, owner_key=owner_key(7), blinding=999
        uint256 ownerKey = LibPiiHash.hash2(7, 0);                    // owner_key(7)
        uint256 secret   = LibPiiHash.hash2(ownerKey, 999);           // hash2(ok, blinding)
        uint256 cmt      = LibPiiHash.noteCommitment(5, 1000, secret); // hash3(5, 1000, secret)
        assertEq(cmt, GV_NOTE_CMT, "note commitment");
    }

    function test_nullifier() public pure {
        // SPEC §2: nullifier = hash2(commitment, spending_key=7)
        uint256 ownerKey = LibPiiHash.hash2(7, 0);
        uint256 secret   = LibPiiHash.hash2(ownerKey, 999);
        uint256 cmt      = LibPiiHash.noteCommitment(5, 1000, secret);
        uint256 nf       = LibPiiHash.piiNullifier(cmt, 7);
        assertEq(nf, GV_NULLIFIER, "nullifier");
    }

    function test_order_commitment() public pure {
        // SPEC §2: hash8(side=0, price=2e7, amount=10, asset_base=5, asset_quote=6, owner_key(7), nonce=42, expiry=1800000000)
        uint256 ownerKey = LibPiiHash.hash2(7, 0);
        uint256 got = LibPiiHash.orderCommitment(
            0,          // side
            20_000_000, // price (2e7)
            10,         // amount
            5,          // asset_base
            6,          // asset_quote
            ownerKey,   // owner_key(7)
            42,         // nonce
            1_800_000_000 // expiry
        );
        assertEq(got, GV_ORDER_CMT, "order commitment (v3 field order)");
    }

    // ────────────────────────────────────────────────────────────────────────
    // §D  Root history: every root stays valid after 60 inserts
    // ────────────────────────────────────────────────────────────────────────

    function test_old_roots_stay_valid_after_60_inserts() public {
        // Collect the first 5 roots (including empty root at slot 0)
        uint256[5] memory earlyRoots;
        earlyRoots[0] = merkle.currentRoot(); // empty tree root

        // Insert leaves 0..3 and record roots 1..4
        for (uint256 i = 0; i < 4; i++) {
            (, uint256 r) = merkle.insert(uint256(keccak256(abi.encode("leaf", i))));
            earlyRoots[i + 1] = r;
        }

        // Insert 56 more leaves (total = 60 inserts beyond the initial empty root)
        for (uint256 i = 4; i < 60; i++) {
            merkle.insert(uint256(keccak256(abi.encode("leaf", i))));
        }

        // All 5 early roots must still be valid (permanent root history)
        for (uint256 i = 0; i < 5; i++) {
            assertTrue(
                merkle.isKnownRoot(earlyRoots[i]),
                string.concat("root[", vm.toString(i), "] should still be valid after 60 inserts")
            );
        }
    }

    // ────────────────────────────────────────────────────────────────────────
    // §E  Gas measurement for one depth-20 insert
    // ────────────────────────────────────────────────────────────────────────

    function test_insert_gas() public {
        uint256 leaf = uint256(keccak256("gas-test-leaf"));
        uint256 gasBefore = gasleft();
        merkle.insert(leaf);
        uint256 gasUsed = gasBefore - gasleft();
        console.log("Depth-20 insert gas (Yul Poseidon2):", gasUsed);
        // Sanity bounds: should be between 200k and 2M (SPEC §3 targets ~740k)
        assertGt(gasUsed, 200_000, "unexpectedly cheap - check library");
        assertLt(gasUsed, 2_000_000, "unexpectedly expensive - check library");
    }
}
