# Pii — Private Payments

Private USDC transfers and payments on Arc Testnet, powered by UltraHonk zero-knowledge proofs. Users deposit USDC into a shared pool, send privately to Pii addresses, and withdraw to any Ethereum address — without revealing sender, receiver, or amount on-chain.

Built with [Arc Studio](https://studio.arc.io)

## Tech stack

- React + Vite + TypeScript (frontend)
- wagmi v2 + ConnectKit (wallet connection)
- Aztec bb.js + Noir (UltraHonk prover, runs in-browser via Web Worker)
- Solidity contracts: PiiPool (shielded pool), PiiKeyRegistry, ZKTranscriptLib, RelationsLib, WithdrawVerifier, TransferVerifier
- Bun (package manager and scripts)
- Foundry (contract compilation and testing)
- Arc Testnet (chainId 5042002) — USDC as native gas

## Development

### Prerequisites

- Bun >= 1.x
- Foundry (`forge` in PATH)
- Nargo 1.0.0-rc.5 and bb 5.2.1 (for circuit work only)
- Node.js (for Noir tooling)

### Install

```sh
bun install
```

### Environment variables

Copy from `env/env.example` to `env/.env` and fill in:

| Variable | Purpose |
|---|---|
| `RELAYER_PRIVATE_KEY` | Relayer wallet private key |
| `RELAYER_SPENDING_KEY` | Relayer Pii spending key |
| `POOL_ADDRESS` | Deployed PiiPool address |
| `RPC_URL` | Arc Testnet RPC endpoint |
| `CHAIN_ID` | 5042002 (Arc Testnet) |
| `MIN_FEE` | Minimum relayer fee in USDC atoms |
| `PORT` | Relayer HTTP port (default 3001) |
| `RATE_LIMIT_RPM` | Requests per minute limit |
| `TESTNET_DEPLOYER_KEY` | Deployer key for Arc Testnet deploys |
| `TESTNET_RELAYER_KEY` | Relayer key for Arc Testnet |

`RPC_PROXY_BASE_URL`, `RPC_PROXY_TOKEN`, `RPC_PROXY_CHAINS` are set by Arc Studio automatically and are optional outside Arc Studio.

### Run

```sh
# Start the frontend (Vite dev server)
bun run dev

# Start the relayer (in a separate terminal)
bun run relayer:dev

# Run all unit tests
bun test

# Run Foundry tests
forge test

# Check types and lint
bun run check
```

### Build

```sh
bun run build
```

### Deploy (Arc Testnet only, explicit approval required)

```sh
bun run deploy:arc-testnet
```

## Features

- **Portfolio** — view your private USDC balance and notes
- **Deposit** — shield USDC into the pool (approve + deposit)
- **Pay** — private transfer to a Pii address (ZK proof generated in browser)
- **Payroll** — CSV batch private transfers, resumes on failure
- **Withdraw** — unshield USDC to any Ethereum address

Keys are derived from an EIP-712 wallet signature and kept in memory only — never stored.

## Deployed contracts (Arc Testnet)

See `deployments/arc-testnet.json` and `AGENTS.md` for all addresses and transaction hashes.
