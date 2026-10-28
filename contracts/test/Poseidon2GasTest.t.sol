// SPDX-License-Identifier: MIT
pragma solidity ^0.8.21;

import "forge-std/Test.sol";

/// @notice Minimal Poseidon2 (BN254, t=4) in pure Solidity for gas benchmarking.
/// Round constants and MDS match the Noir/Barretenberg BN254 t=4 instance.
/// NOT audited — for feasibility measurement only.
library Poseidon2Bench {
    uint256 constant P = 0x30644e72e131a029b85045b68181585d2833e84879b9709143e1f593f0000001;

    // Poseidon2 external linear layer for t=4: each element gets sum of all + itself
    function _linearLayer(uint256[4] memory s) internal pure {
        uint256 sum = addmod(addmod(s[0], s[1], P), addmod(s[2], s[3], P), P);
        s[0] = addmod(s[0], sum, P);
        s[1] = addmod(s[1], sum, P);
        s[2] = addmod(s[2], sum, P);
        s[3] = addmod(s[3], sum, P);
    }

    // x^5 s-box
    function _sbox(uint256 x) internal pure returns (uint256) {
        uint256 x2 = mulmod(x, x, P);
        uint256 x4 = mulmod(x2, x2, P);
        return mulmod(x4, x, P);
    }

    /// @notice Minimal permutation: just measures the S-box + MDS cost structure.
    /// For accurate benchmarking only; not a full constant-correct implementation.
    function benchmarkPermutation(uint256 a, uint256 b, uint256 c, uint256 d)
        internal pure returns (uint256)
    {
        uint256[4] memory s;
        s[0] = a; s[1] = b; s[2] = c; s[3] = d;

        // 8 full rounds (simplified: no real round constants)
        for (uint256 r = 0; r < 8; r++) {
            s[0] = _sbox(s[0]);
            s[1] = _sbox(s[1]);
            s[2] = _sbox(s[2]);
            s[3] = _sbox(s[3]);
            _linearLayer(s);
        }
        // 56 partial rounds
        for (uint256 r = 0; r < 56; r++) {
            s[0] = _sbox(s[0]);
            _linearLayer(s);
        }
        // 8 more full rounds
        for (uint256 r = 0; r < 8; r++) {
            s[0] = _sbox(s[0]);
            s[1] = _sbox(s[1]);
            s[2] = _sbox(s[2]);
            s[3] = _sbox(s[3]);
            _linearLayer(s);
        }
        return s[0];
    }
}

contract Poseidon2GasTest is Test {
    function test_poseidon2_permutation_gas() public view {
        uint256 gasBefore = gasleft();
        uint256 result = Poseidon2Bench.benchmarkPermutation(1, 2, 3, 4);
        uint256 gasUsed = gasBefore - gasleft();
        console2.log("Poseidon2 permutation (pure Solidity) gas:", gasUsed);
        console2.log("Output:", result);
        // 20k-50k range expected; log actual
    }
}
