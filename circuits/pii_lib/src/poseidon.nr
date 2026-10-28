// Poseidon2 BN254 sponge — Pii canonical implementation.
//
// Construction (SPEC §2, identical to zemse/poseidon2-evm Yul and @zkpassport/poseidon2):
//   t = 4, rate = 3, capacity = 1
//   state = [0, 0, 0,  IV]   where IV = N * 2^64  (N = number of inputs)
//   absorb inputs into lanes [0..2] in order;
//   permute whenever a full block of 3 is absorbed AND more inputs remain;
//   after all inputs are absorbed, one final permutation (squeeze);
//   output = state[0].
//
// Permutation: std::hash::poseidon2_permutation(state)  (1-argument form in nargo rc.5).
//
// This matches the behavior of LibPoseidon2Yul.hash_N (Solidity) and
// poseidon2Hash (TypeScript @zkpassport/poseidon2 v0.6.2).
// Confirmed by the golden-vector gate (Stage 0).

// ── IV helper ─────────────────────────────────────────────────────────────────
fn iv(n: u64) -> Field {
    (n as Field) * 0x10000000000000000 // 2^64
}

// ── hash2 ─────────────────────────────────────────────────────────────────────
// N=2: state=[1,2,0, 2<<64]. No mid-loop permute (lane never hits 3). Final permute.
pub fn hash2(a: Field, b: Field) -> Field {
    let mut state: [Field; 4] = [a, b, 0, iv(2)];
    state = std::hash::poseidon2_permutation(state);
    state[0]
}

// ── hash3 ─────────────────────────────────────────────────────────────────────
// N=3: state=[1,2,3, 3<<64]. One permutation (the "full" block IS the only block). Final permute.
pub fn hash3(a: Field, b: Field, c: Field) -> Field {
    let mut state: [Field; 4] = [a, b, c, iv(3)];
    state = std::hash::poseidon2_permutation(state);
    state[0]
}

// ── hash4 ─────────────────────────────────────────────────────────────────────
// N=4: absorb [a,b,c] into [s0,s1,s2], permute; absorb [d] into s0; final permute.
pub fn hash4(a: Field, b: Field, c: Field, d: Field) -> Field {
    let mut state: [Field; 4] = [a, b, c, iv(4)];
    state = std::hash::poseidon2_permutation(state); // block 1 done
    state[0] = state[0] + d;                         // absorb 4th input
    state = std::hash::poseidon2_permutation(state); // squeeze
    state[0]
}

// ── hash8 ─────────────────────────────────────────────────────────────────────
// N=8: absorb [a,b,c] permute; absorb [d,e,f] permute; absorb [g,h] final permute.
pub fn hash8(a: Field, b: Field, c: Field, d: Field, e: Field, f: Field, g: Field, h: Field) -> Field {
    let mut state: [Field; 4] = [a, b, c, iv(8)];
    state = std::hash::poseidon2_permutation(state);         // block 1 done
    state[0] = state[0] + d;
    state[1] = state[1] + e;
    state[2] = state[2] + f;
    state = std::hash::poseidon2_permutation(state);         // block 2 done
    state[0] = state[0] + g;
    state[1] = state[1] + h;
    state = std::hash::poseidon2_permutation(state);         // squeeze
    state[0]
}

// Generic sponge (exported for callers that need a variable-length interface).
// Uses the same logic as above but in a loop.  For fixed arities, prefer the
// dedicated functions above — they are more readable and produce the same result.
pub fn poseidon2_hash<let N: u32>(inputs: [Field; N]) -> Field {
    let mut state: [Field; 4] = [0, 0, 0, iv(N as u64)];
    let mut lane: u32 = 0;

    for i in 0..N {
        state[lane] = state[lane] + inputs[i];
        lane += 1;
        // Permute when a full block is ready AND there are more inputs to absorb.
        if (lane == 3) & (i < N - 1) {
            state = std::hash::poseidon2_permutation(state);
            lane = 0;
        }
    }
    // Final squeeze permutation.
    state = std::hash::poseidon2_permutation(state);
    state[0]
}
