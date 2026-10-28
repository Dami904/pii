// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import "forge-std/Test.sol";
import {PiiKeyRegistry} from "../src/PiiKeyRegistry.sol";

contract PiiKeyRegistryTest is Test {
    PiiKeyRegistry reg;

    address constant ALICE = address(0xA11CE);
    address constant BOB   = address(0xB0B);

    // A valid 33-byte compressed secp256k1 key (prefix 0x02)
    bytes constant VALID_KEY_02 = hex"0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798";
    // A valid 33-byte compressed secp256k1 key (prefix 0x03)
    bytes constant VALID_KEY_03 = hex"0379be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798";

    function setUp() public {
        reg = new PiiKeyRegistry();
    }

    // ── register ─────────────────────────────────────────────────────────────

    function test_register_stores_key() public {
        vm.prank(ALICE);
        vm.expectEmit(true, false, false, true);
        emit PiiKeyRegistry.KeyRegistered(ALICE, VALID_KEY_02);
        reg.register(VALID_KEY_02);

        assertEq(reg.getKey(ALICE), VALID_KEY_02, "key stored");
    }

    function test_register_prefix_03() public {
        vm.prank(ALICE);
        reg.register(VALID_KEY_03);
        assertEq(reg.getKey(ALICE), VALID_KEY_03, "03-prefix stored");
    }

    function test_register_rotation_overwrites() public {
        vm.prank(ALICE);
        reg.register(VALID_KEY_02);
        vm.prank(ALICE);
        reg.register(VALID_KEY_03);
        assertEq(reg.getKey(ALICE), VALID_KEY_03, "key rotated");
    }

    function test_register_wrong_length_reverts() public {
        vm.prank(ALICE);
        vm.expectRevert(PiiKeyRegistry.InvalidKeyLength.selector);
        reg.register(hex"0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f817"); // 32B
    }

    function test_register_wrong_prefix_reverts() public {
        // Prefix 0x04 (uncompressed marker) — should revert
        bytes memory bad = abi.encodePacked(
            uint8(0x04),
            bytes32(hex"79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798")
        );
        vm.prank(ALICE);
        vm.expectRevert(PiiKeyRegistry.InvalidKeyPrefix.selector);
        reg.register(bad);
    }

    function test_unregistered_returns_empty() public view {
        assertEq(reg.getKey(BOB).length, 0, "no key = empty");
    }

    function test_different_users_independent() public {
        vm.prank(ALICE); reg.register(VALID_KEY_02);
        vm.prank(BOB);   reg.register(VALID_KEY_03);
        assertEq(reg.getKey(ALICE), VALID_KEY_02);
        assertEq(reg.getKey(BOB),   VALID_KEY_03);
    }
}
