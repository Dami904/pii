# Pii

> Private marketplace for tokenized private-company shares — Arc Testnet

This is the **project memory** - what Arc Studio remembers about building this app. It helps future agents (or humans) understand and extend the project.

---

## What This App Does

Pii is a ZK-shielded private marketplace for tokenized private-company shares on Arc Testnet.
It ports Wraith (Stellar/Soroban privacy platform) to Solidity + Noir/UltraHonk on Arc EVM.
Core modules: Bridge (deposit/withdraw USDC), Portfolio (private multi-asset balances),
Pay (shielded transfers), Swap (dark-pool DEX), Issue (primary share sales), Dividends (private distribution).
Notes are Poseidon2 commitments in a depth-20 incremental Merkle tree; spending is proven with UltraHonk proofs verified on-chain.

## Tech Stack

- Frontend: React 18, Vite, TypeScript, Tailwind CSS
- Web3: wagmi v2, viem v2, ConnectKit
- Contracts: Solidity 0.8.28 + Foundry. Sources in `contracts/`, unit tests in `contracts/test/*.t.sol`.
- ZK: Noir 1.0.0-rc.5 (nargo), Barretenberg 5.2.1 (@aztec/bb.js), UltraHonk proofs + EVM verifier
- Poseidon2: zemse/poseidon2-evm (Yul, ~20k gas/hash) on-chain; @zkpassport/poseidon2 in SDK (golden-vector gated)
- Wallet: injected (MetaMask, etc.)
- Chain: Arc Testnet (Chain ID: 5042002)
- Token: USDC (Address: 0x3600000000000000000000000000000000000000, Arc Testnet, 6-decimal ERC-20 view)
- Toasts: Sonner

## Key Files

- `PLAN.md` — full architecture plan, circuit specs, contract specs, gas budget, threat model, build stages
- `docs/zk-marketplace-feasibility.md` — ZK toolchain feasibility report (nargo + bb confirmed working)
- `src/App.tsx` — Main application (to be built as 6-tab UI per PLAN.md)
- `contracts/UltraHonkVerifier.sol` — Generated verifier from feasibility probe (trivial circuit)
- `contracts/test/HonkVerifierTest.t.sol` — Forge test proving real UltraHonk proof (gas: 1,936,926)
- `contracts/test/Poseidon2GasTest.t.sol` — Poseidon2 permutation gas benchmark (69,697 pure Solidity)

## Deployed Contracts

Arc Testnet (chainId 5042002) — deploy block **69004920**

| Contract | Address |
|---|---|
| PiiPool | `0x75bc90aa025caeedde588295d42b8f19a8e4bff3` |
| PiiKeyRegistry | `0x9e3a4256791edcba981d88e55d932a76b9cb8e29` |
| WithdrawVerifier | `0xa412b824f53650a9b582bf685b7bfe31bf324721` |
| TransferVerifier | `0x1b55cbe0de87cef666160762d42da1f3358de39e` |
| ZKTranscriptLib | `0x24d22d1576f9df6f1a87054fcae3d36beb9c2e80` |
| RelationsLib | `0x13cfe5a8ae0836a03bb95c1f83a521c3a0123e63` |

Full record: `deployments/arc-testnet.json`. Explorer: https://explorer.testnet.arc.io

## Arc Mainnet Prep

Chain ID: **5042** | RPC: `https://rpc.mainnet.arc.io` | Explorer: `https://explorer.arc.io`
USDC: `0x3600000000000000000000000000000000000000` (same address as testnet)
Deploy script: `scripts/deploy-arc-mainnet.ts` — requires `--confirm-mainnet` flag and `MAINNET_DEPLOYER_KEY` + `MAINNET_OWNER` env vars.
Network switch: set `VITE_NETWORK=mainnet` at build time to activate mainnet chain + deployment JSON.
Deployment placeholder at `deployments/arc-mainnet.json` — zero addresses until mainnet deploy runs.
Addresses that need mainnet USDC for gas: deployer (`MAINNET_DEPLOYER_KEY`) + relayer (`MAINNET_RELAYER_KEY`).

## To Run

```bash
bun install
bun run dev
```

## Scripts

| Script | Purpose |
|---|---|
| `bun run smoke:testnet` | Full E2E smoke test on Arc Testnet |
| `bun run deploy:arc-testnet` | Deploy contracts to Arc Testnet |
| `bun run deploy:arc-mainnet` | Deploy contracts to Arc Mainnet (requires --confirm-mainnet) |
| `bun run build:check` | Production Vite build |
