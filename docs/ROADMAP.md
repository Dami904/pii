# Pii build roadmap: small Arc Studio chunks

Every chunk is one Arc Studio turn of about 5–15 minutes: ONE coherent task, its own tests, and a
PASS/FAIL report at the end. Arc Studio writes and tests all code. After each chunk, the code is pulled
and re-checked locally against the golden vectors and attack tests in `docs/PII_SPEC_V1.md`.
Network: **Arc Testnet** until v1 is complete and reviewed. The mainnet deploy (with deposit caps) is
its own chunk and needs explicit human approval.

Grant target: Arc Microgrants "Built with Arc Studio", deadline 2026-11-02 05:59 UTC.
Goal: submit **v1 + v2 + v3**, each one live on Arc mainnet (deposit and pool caps, a demo issuer, tiny amounts).

| Milestone | Target date | Fallback guarantee |
|---|---|---|
| v1 live on mainnet (real USDC private payout) | 2026-10-25 | an eligible submission exists from here on |
| v2 private shares on mainnet (demo issuer) | 2026-10-29 | |
| v3 dark pool + dividends on mainnet | 2026-11-01 | |
| Submit | 2026-11-01 | any unfinished module is shown as "next", never shipped half-done |

Where safe, a circuit and its proof pipeline are merged into one chunk (e.g. 3+4, 5+6, and similarly for v2/v3).

## v1: Pii Pay (shielded USDC pool: private transfers and payroll payouts)

| # | Chunk | Acceptance |
|---|---|---|
| 1 | Hash + Merkle alignment: fix the order-commitment field order, the domain-separated ZERO_VALUE, full root history (mapping), remove the test-only public insert | forge: every vector in SPEC §2 matches; old roots stay valid after 60 inserts |
| 2 | Noir `circuits/pii_lib`: sponge, notes, nullifier, order, merkle, output sentinel, eligibility leaf, path helper | nargo test: SPEC §2 vectors match |
| 3 | `withdraw` circuit (USDC only, partial with change) | SPEC §4.1 positive and negative tests |
| 4 | withdraw proof pipeline: TS fixture, then nargo execute, bb prove, the Solidity verifier, forge verify, and tamper tests | real proof verifies; 4 tamper cases rejected |
| 5 | `transfer` circuit (2 inputs + a USDC fee input, 4 outputs) | SPEC §4.2 positive and negative tests |
| 6 | transfer proof pipeline + verifier + forge test | real proof verifies |
| 7 | `PiiPool.sol` part A: deposit (commitment computed on-chain), withdraw, ext_data_hash, relayer fee, caps, pause of new deposits only | forge with real proofs, plus the deposit-drain attack test |
| 8 | `PiiPool.sol` part B: transfer, memos in events, sentinel skip, full flow deposit, transfer, withdraw | forge E2E with real proofs |
| 9 | SDK: keys from a wallet signature, note store, tree sync from events, in-browser proving (bb.js) | TS tests + one in-node proof |
| 10 | Memo encryption (secp256k1 ECIES) + key registry contract | round-trip tests; a forged memo cannot mint |
| 11 | Relayer service (submits proofs, paid by a USDC fee note) | local anvil E2E |
| 12 | Frontend A: connect, deposit, portfolio | runs in the Arc Studio preview |
| 13 | Frontend B: private pay + payroll (batch payouts) + withdraw | E2E in the preview on testnet |
| 14 | Arc Testnet deploy + scripted E2E with real tx hashes | explorer links |
| 15 | Review chunk: Slither + Arc Studio audit + fixes | findings triaged |
| 16 | **Mainnet deploy (human approval)** with caps, plus one real private payroll payout | explorer.arc.io links |
| 17 | Submission assets: README, video walkthrough of the Arc Studio build | grant checklist |

## v2: private shares (after the grant)
18 issuer registry + genesis issuance · 19 eligibility tree + admin root updates (50 roots / 7 days) ·
20 `transfer` share-eligibility proof wired to the registry · 21 `buy_primary` circuit (in-circuit fee) ·
22 pool integration · 23 issuer and investor UI · 24 auditor memo encryption + viewing-bundle export.

## v3: dark pool + dividends
25 `place_order` · 26 `cancel_order` · 27 `match_orders` (midpoint, refunds, expiry) · 28 matcher
service · 29 `claim_dividend` + DividendManager · 30 swap and dividend UI · 31 review + deploy.
