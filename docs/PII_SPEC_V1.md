# Pii v1 spec: the single source of truth for every chunk

Everything Arc Studio writes must reproduce the values here byte for byte. When this spec and
PLAN.md disagree, this spec wins (PLAN.md §3–4 still show the older hash4 notes and the zero empty leaf).

## 1. Toolchain
nargo 1.0.0-rc.5 · @aztec/bb.js 5.2.1 (`bb`) · Solidity 0.8.28, Foundry · Poseidon2 on-chain = zemse/poseidon2-evm
Yul (`LibPoseidon2Yul`), plus the full-permutation helper for arities above 3 · TS = @zkpassport/poseidon2 0.6.2.
Noir uses a hand-built sponge over `std::hash::poseidon2_permutation(state)`, because poseidon v0.2.0 does not build on rc.5.

## 2. Formats and golden vectors
Poseidon2 BN254, t=4, rate 3, IV = n<<64 in state[3], absorb into lanes 0..2, permute when full, final permute, output state[0].

| Value | Definition | Golden |
|---|---|---|
| hash2(1,2) | | 0x038682aa1cb5ae4e0a3f13da432a95c77c5c111f6f030faf9cad641ce1ed7383 |
| hash2(0,0) | | 0x0b63a53787021a4a962a452c2921b3663aff1ffd8d5510540f8e659e782956f1 |
| hash3(1,2,3) | | 0x23864adb160dddf590f1d3303683ebcb914f828e2635f6e85a32f0a1aecd3dd8 |
| hash4(1,2,3,4) | | 0x130bf204a32cac1f0ace56c78b731aa3809f06df2731ebcf6b3464a15788b1b9 |
| hash8(1..8) | | 0x01dec21c6e1b30609eda618d7e35e5d9d6152f8fa67320d939c1a89603647142 |
| ZERO_VALUE | keccak256("pii-shielded-pool-v1") mod r (empty leaf AND the "no output" sentinel) | 0x10aa41cd532efb9f2b7337c3f588d65e4af1b6c5bc76a7faa5db259c06ec2466 |
| empty root | zeros[0]=ZERO_VALUE, zeros[i]=hash2(zeros[i-1],zeros[i-1]), root=zeros[20] | 0x19ee29beb37701dd87b245c58cc348522c86f063f3aa049d19d6fddc71de23c7 |
| owner_key(sk) | hash2(sk, 0); owner_key(7) = | 0x0b0f697117aa52458ddd243aeeac42e2a58175474f8889f3d763521eea2ce64b |
| note commitment | hash3(asset_id, amount, hash2(owner_key, blinding)); (5, 1000, owner_key(7), 999) = | 0x0c91a967c6efc9312a70afc4e9da7a96849449459ab6e1e9f023162a0ee5f360 |
| nullifier | hash2(commitment, sk); for the note above with sk=7 = | 0x1153d7217f751902fd027cab215bcc2ee93bec902ee4e0f557a7e5cbaab99788 |
| order (v3) | hash8(side, price, amount, asset_base, asset_quote, owner_key, nonce, expiry); (0, 2e7, 10, 5, 6, owner_key(7), 42, 1800000000) = | 0x2e41f6b075f636c0b7ac654984c605f2b6119c600c1aacffc96f7b49c760ec42 |
| asset_id(token) | hash2(uint160(token), 0). USDC = 0x3600000000000000000000000000000000000000 | (computed) |
| output sentinel | an output with amount 0 MUST equal ZERO_VALUE; PiiPool skips inserting it | |
| eligibility leaf (v2) | hash2(asset_id, owner_key) in one platform-wide tree | |

Range: every amount < 2^64 (`assert_max_bit_size::<64>`) before any integer comparison. `as u64` casts truncate silently.

## 3. Merkle tree
Depth 20, append-only, insert bit 0 = left child. **Every root ever produced stays valid**
(`mapping(uint256 => bool) isKnownRoot`). The 50-root/7-day window applies ONLY to v2 eligibility/KYC roots.
Measured: about 27k gas per hash2 (Yul), about 0.74M gas per insert.

## 4. Circuits (public inputs in this exact order)

### 4.1 withdraw (USDC only; shares never leave the pool)
`merkle_root, nullifier, recipient (uint160), amount, change_commitment, ext_data_hash`
private: `spending_key, note_amount, note_blinding, merkle_siblings[20], merkle_bits[20], change_blinding`
Rules: the note is rebuilt as asset=USDC; the nullifier matches; Merkle membership holds; amount != 0; amount <= note;
change = note − amount goes to the same owner as `output_commitment` (the sentinel if 0); recipient < 2^160 and != 0.
Tests that MUST fail: overdraw, inflated change, change to another owner, sentinel while change > 0, wrong key,
note not in tree, a share note, zero amount. Measured verify gas ≈ 2.84M; proof 7616 bytes.

### 4.2 transfer
`merkle_root, nf_0, nf_1, nf_fee, out_recipient, out_change, out_fee, out_fee_change, eligibility_root, fee, relayer_owner_key, ext_data_hash`
- Inputs: in[0] (real) and in[1] (may be a phantom with amount 0, so no Merkle check, but its nullifier is still burned) of the same asset A,
  plus a USDC `fee_in` (phantom when fee = 0). All three nullifiers are pairwise distinct.
- A: in0 + in1 = send + change, where the change goes to owner_key(in_sk[0]). USDC: fee_in = fee + fee_change, where the fee note
  goes to relayer_owner_key and the fee change goes back to fee_in's owner. Each output uses the output_commitment sentinel rule.
- If A != USDC and send != 0, then eligibility_leaf(A, recipient_owner) must be in eligibility_root (v1 always sends USDC).
Tests that MUST fail: an ineligible share recipient, overspend, fee overspend, an inflated output, the same note twice, a fee paid with a share note.

## 5. PiiPool (chunks 7–8)
- `deposit(amount, secret)`: pulls USDC, computes the commitment on-chain as hash3(USDC_ID, amount, secret), and inserts it.
  The user never supplies the commitment. A test MUST show the drain attack fails: deposit 1 and try to withdraw 10^12.
- `ext_data_hash = uint256(keccak256(abi.encode(memos, relayer, fee, recipient, block.chainid, address(this)))) % r`.
  It is recomputed for every proof-gated call and must equal the public input.
- withdraw: the contract pays `amount − fee` to the recipient and `fee` to the relayer (public USDC). Transfer pays the relayer via the fee note.
- Outputs equal to ZERO_VALUE are not inserted. Roots must be known. Nullifiers are marked spent BEFORE external transfers. Use ReentrancyGuard.
- Admin (Ownable2Step): set caps, pause NEW deposits only. Withdraw and transfer can never be paused.
  Caps: maxDeposit and maxPoolBalance (for the mainnet experiment, e.g. 5 and 50 USDC).
- Events carry the commitments, leaf indices and encrypted memos.
