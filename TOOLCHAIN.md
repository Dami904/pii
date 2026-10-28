# Pii — Toolchain Pin

> Stage 0 result. Do NOT upgrade any pinned version without re-running the golden-vector gate.

## Pinned Versions

| Component | Version | How to install |
|---|---|---|
| nargo (Noir compiler) | `1.0.0-rc.5` | `curl -L https://raw.githubusercontent.com/noir-lang/noirup/main/install \| bash && noirup -v 1.0.0-rc.5` |
| @aztec/bb.js (Barretenberg) | `5.2.1` | `bun add -g @aztec/bb.js@5.2.1` |
| Poseidon2 Solidity | `zemse/poseidon2-evm v2.0.0` | `forge install zemse/poseidon2-evm` |
| Poseidon2 TypeScript | `@zkpassport/poseidon2 v0.6.2` | `bun add @zkpassport/poseidon2` |

## Version-lock rationale

- `nargo 1.0.0-rc.5` + `bb.js 5.2.1`: confirmed working in this sandbox end-to-end (proof generated, native verify passed, Solidity verifier compiled). The UltraHonk proof format, VK format, and `HonkVerifier.sol` bytecode are coupled to the `bb` version. Never upgrade silently.
- `poseidon2-evm v2.0.0` + `@zkpassport/poseidon2 v0.6.2`: both pass the golden-vector gate (all 7 vectors, Noir == Solidity == TypeScript). See Stage 0 results below.

## CRITICAL: Noir `poseidon` library v0.2.0 incompatibility

The Wraith reference used `dep::poseidon::poseidon2::Poseidon2` from `github.com/noir-lang/poseidon@v0.2.0`.
**This library is incompatible with nargo 1.0.0-rc.5.** Specifically, the library calls
`crate::poseidon2_permutation(state, 4)` with 2 arguments, but the rc.5 stdlib changed
`std::hash::poseidon2_permutation` to take only 1 argument. The library fails to compile.

**Resolution:** Pii implements the Poseidon2 sponge directly using `std::hash::poseidon2_permutation`
from the rc.5 stdlib. The sponge construction (t=4, rate=3, IV = message_size << 64, output = state[0])
is identical to the v0.2.0 library — same permutation, same IV scheme, same output. The golden-vector
gate confirms byte-for-byte agreement with the zemse/poseidon2-evm Solidity library and @zkpassport/poseidon2 TypeScript library.

## Proof format

- Transcript: `--oracle_hash keccak` (keccak transcript, required for EVM verifier)
- Trivial circuit (128 gates) proof: **5,312 bytes** (from feasibility probe)
- VK: 1,888 bytes (from feasibility probe)
- Production circuits will have different proof/VK sizes — record after Stage 1 compilation.

## UltraHonkBackend (bb.js)

The keccak transcript corresponds to `UltraHonkBackend` in bb.js (no special flag needed as of 5.2.1 — the default backend uses keccak). Verify before production: `new UltraHonkBackend(circuit)` should produce proofs accepted by the Solidity `HonkVerifier` generated with `bb write_solidity_verifier --oracle_hash keccak`.

---

## Stage 0 Results (PASS)

### Exact commands run

```bash
# 1. Verify versions
export PATH="$HOME/.nargo/bin:$HOME/.bb:$HOME/.bun/bin:$PATH"
nargo --version
# → nargo version = 1.0.0-rc.5

bb --version  # ($HOME/.bun/bin/bb from @aztec/bb.js)
# → 5.2.1

# 2. Generate Noir golden vectors (pii_stdlib_test circuit)
cd /tmp/pii_stdlib_test && nargo test --show-output
# → 7 tests passed (see golden values below)

# 3. Solidity golden-vector gate + gas measurement
cd /home/user/app && forge test --match-contract Poseidon2GoldenVectorTest -vvv
# → 10 tests passed (see results below)

# 4. TypeScript golden-vector gate
cd /home/user/app && bun test sdk/test/poseidon.golden.test.ts
# → 7 pass, 0 fail
```

### Golden Vectors (Noir source of truth)

| Input | Output (BN254 Fr, hex) |
|---|---|
| `hash2(1, 2)` | `0x038682aa1cb5ae4e0a3f13da432a95c77c5c111f6f030faf9cad641ce1ed7383` |
| `hash2(0, 0)` | `0x0b63a53787021a4a962a452c2921b3663aff1ffd8d5510540f8e659e782956f1` |
| `hash3(1, 2, 3)` | `0x23864adb160dddf590f1d3303683ebcb914f828e2635f6e85a32f0a1aecd3dd8` |
| `hash4(1, 2, 3, 4)` | `0x130bf204a32cac1f0ace56c78b731aa3809f06df2731ebcf6b3464a15788b1b9` |
| `hash8(1..8)` | `0x01dec21c6e1b30609eda618d7e35e5d9d6152f8fa67320d939c1a89603647142` |
| `zeros[1] = hash2(0,0)` | `0x0b63a53787021a4a962a452c2921b3663aff1ffd8d5510540f8e659e782956f1` |
| `zeros[20] (empty tree root, depth 20)` | `0x1c8c3ca0b3a3d75850fcd4dc7bf1e3445cd0cfff3ca510630fd90b47e8a24755` |

### Measured Gas (zemse/poseidon2-evm pure-Solidity BN254, forge test)

| Operation | Measured gas |
|---|---|
| `hash2` (pure Solidity LibPoseidon2) | **219,743** |
| `hash3` (pure Solidity LibPoseidon2) | **220,258** |
| `hash4` (pure Solidity LibPoseidon2) | via `hash` fn, ~407k total test |
| Depth-20 Merkle insert (20 × hash2, pure-Solidity) | **6,800,461** |

> **WARNING:** The pure-Solidity implementation is ~220k gas per hash2 and ~6.8M for a full
> depth-20 insert. This is substantially higher than the 20k/hash estimate from the feasibility probe
> (which used a gas-cost skeleton, not the real library). See gas budget impact below.

### Gas Budget Impact (REVISED from PLAN.md §7)

| Operation | ZK verify (est.) | Merkle inserts | **Total (REAL insert cost)** | Within 10M? |
|---|---|---|---|---|
| `deposit` (no circuit) | 0 | 1 × 6.8M | **~6.9M** | YES (barely) |
| `withdraw` | ~2.2M | 1 × 6.8M | **~9.1M** | YES (just under 10M) |
| `transfer` | ~2.8M | 3 × 6.8M | **~23.2M** | **EXCEEDS 10M — BLOCKER** |
| `placeOrder` | ~3.0M | 1 × 6.8M | **~9.9M** | YES (borderline) |
| `matchOrders` | ~3.5M | up to 8 × 6.8M | **~58M** | **EXCEEDS 30M — BLOCKER** |
| `cancelOrder` | ~2.1M | 1 × 6.8M | **~8.9M** | YES |
| `buyPrimary` | ~3.5M | 3 × 6.8M | **~24M** | **EXCEEDS 10M — BLOCKER** |
| `claimDividend` | ~2.5M | 1 × 6.8M | **~9.3M** | YES (borderline) |

**The pure-Solidity Poseidon2 library is too expensive for multi-insert operations on Arc (30M gas/block).**

### Required Action Before Stage 1

Use the **Yul-compiled version** (`Poseidon2Yul_BN254`) instead of the pure-Solidity version.
The Yul contract is included in `zemse/poseidon2-evm` and passes the same golden-vector test.
Gas for the Yul version is expected to be ~2,000–5,000 gas per hash2 (per the library's own benchmarks).
A depth-20 insert would then be ~40k–100k gas, making all operations comfortably under 10M.

The golden-vector gate must be re-run with the Yul contract deployed on-chain (anvil fork) before
proceeding to Stage 1. This is the first task of Stage 1 setup.

Note: the Yul contract requires on-chain deployment (it is a standalone contract, not a library).
In the forge test environment, deploy it with `new Poseidon2Yul_BN254()` and call via `IPoseidon2`.
