// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import "forge-std/Test.sol";
import {TransferVerifier} from "../verifiers/TransferVerifier.sol";

interface ITransferVerifier {
    function verify(bytes calldata _proof, bytes32[] calldata _publicInputs) external view returns (bool);
}

/**
 * @title TransferVerifierTest
 * @notice Verifies the real UltraHonk transfer proof and checks that 3 tampers are rejected.
 *
 * Public inputs (12 × 32 bytes = 384 bytes):
 *   [0] merkle_root
 *   [1] nf_0
 *   [2] nf_1
 *   [3] nf_fee
 *   [4] out_recipient
 *   [5] out_change
 *   [6] out_fee
 *   [7] out_fee_change
 *   [8] eligibility_root
 *   [9] fee
 *   [10] relayer_owner_key
 *   [11] ext_data_hash
 */
contract TransferVerifierTest is Test {
    TransferVerifier public verifier;
    bytes           public proof;
    bytes32[] public pubInputs;

    function setUp() public {
        verifier   = new TransferVerifier();
        proof      = vm.readFileBinary("contracts/test/fixtures/transfer_proof.bin");
        bytes memory raw = vm.readFileBinary("contracts/test/fixtures/transfer_public_inputs.bin");

        // 384 bytes = 12 × 32-byte words
        uint256 count = raw.length / 32;
        pubInputs = new bytes32[](count);
        for (uint256 i = 0; i < count; i++) {
            bytes32 word;
            assembly { word := mload(add(add(raw, 0x20), mul(i, 0x20))) }
            pubInputs[i] = word;
        }
    }

    function _copyPubInputs() internal view returns (bytes32[] memory) {
        bytes32[] memory copy = new bytes32[](pubInputs.length);
        for (uint256 i = 0; i < pubInputs.length; i++) copy[i] = pubInputs[i];
        return copy;
    }

    // ── Positive ──────────────────────────────────────────────────────────────

    function test_verify_real_proof() public {
        uint256 gasBefore = gasleft();
        bool ok = verifier.verify(proof, pubInputs);
        uint256 gasUsed = gasBefore - gasleft();
        assertTrue(ok, "proof should verify");
        emit log_named_uint("verify() gas", gasUsed);
    }

    // ── Tamper 1: changed fee (pubInputs[9]) ─────────────────────────────────

    function test_tamper_changed_fee() public {
        bytes32[] memory badInputs = _copyPubInputs();
        badInputs[9] = bytes32(uint256(pubInputs[9]) + 1); // change fee by 1
        (bool success, bytes memory data) = address(verifier).staticcall(
            abi.encodeCall(ITransferVerifier.verify, (proof, badInputs))
        );
        bool accepted = success && data.length == 32 && abi.decode(data, (bool));
        assertFalse(accepted, "tampered fee must be rejected");
    }

    // ── Tamper 2: changed relayer_owner_key (pubInputs[10]) ──────────────────

    function test_tamper_changed_relayer_owner_key() public {
        bytes32[] memory badInputs = _copyPubInputs();
        badInputs[10] = bytes32(uint256(9999999));
        (bool success, bytes memory data) = address(verifier).staticcall(
            abi.encodeCall(ITransferVerifier.verify, (proof, badInputs))
        );
        bool accepted = success && data.length == 32 && abi.decode(data, (bool));
        assertFalse(accepted, "tampered relayer must be rejected");
    }

    // ── Tamper 3: swapped out_recipient (pubInputs[4]) ───────────────────────

    function test_tamper_swapped_out_recipient() public {
        bytes32[] memory badInputs = _copyPubInputs();
        badInputs[4] = bytes32(uint256(8888888));
        (bool success, bytes memory data) = address(verifier).staticcall(
            abi.encodeCall(ITransferVerifier.verify, (proof, badInputs))
        );
        bool accepted = success && data.length == 32 && abi.decode(data, (bool));
        assertFalse(accepted, "tampered recipient must be rejected");
    }
}
