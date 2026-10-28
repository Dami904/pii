// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;
import "forge-std/Test.sol";
import {TransferVerifier} from "../verifiers/TransferVerifier.sol";
contract E2EVerifyTest is Test {
    function test_standalone_verify() public {
        TransferVerifier v = new TransferVerifier();
        bytes memory proof = vm.readFileBinary("contracts/test/fixtures/e2e_transfer_proof.bin");
        bytes memory rawPub = vm.readFileBinary("contracts/test/fixtures/e2e_transfer_public_inputs.bin");
        bytes32[] memory pub = new bytes32[](12);
        for (uint256 i = 0; i < 12; i++) {
            bytes32 w;
            assembly { w := mload(add(add(rawPub, 0x20), mul(i, 0x20))) }
            pub[i] = w;
        }
        emit log_named_bytes32("pub[11] ext", pub[11]);
        bool ok = v.verify(proof, pub);
        assertTrue(ok, "verify failed");
    }
}
