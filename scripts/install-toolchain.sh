#!/usr/bin/env bash
# Pii — Stage 0 toolchain installer
# Installs and verifies pinned nargo + bb.js versions.
# Run from the project root: bash scripts/install-toolchain.sh

set -euo pipefail

NARGO_VERSION="1.0.0-rc.5"
BBJS_VERSION="5.2.1"
POSEIDON2_EVM_TAG="v2.0.0"  # zemse/poseidon2-evm (installed via forge install)
ZKPASSPORT_POSEIDON2_VERSION="0.6.2"

echo "=== Pii Toolchain Installer ==="
echo "Pinned: nargo ${NARGO_VERSION}, bb.js ${BBJS_VERSION}"
echo ""

# ── nargo ─────────────────────────────────────────────────────────────────────
if command -v nargo &>/dev/null && nargo --version 2>/dev/null | grep -q "${NARGO_VERSION}"; then
  echo "[OK] nargo ${NARGO_VERSION} already installed"
else
  echo "[INSTALL] Installing nargo ${NARGO_VERSION} via noirup..."
  curl -sL https://raw.githubusercontent.com/noir-lang/noirup/main/install | bash
  export PATH="$HOME/.nargo/bin:$PATH"
  noirup -v "${NARGO_VERSION}"
  echo "[OK] nargo installed"
fi
nargo --version

# ── @aztec/bb.js ──────────────────────────────────────────────────────────────
if command -v bb &>/dev/null && bb --version 2>/dev/null | grep -q "${BBJS_VERSION}"; then
  echo "[OK] bb.js ${BBJS_VERSION} already installed"
else
  echo "[INSTALL] Installing @aztec/bb.js@${BBJS_VERSION}..."
  bun add -g "@aztec/bb.js@${BBJS_VERSION}"
  echo "[OK] bb.js installed"
fi
bb --version

# ── poseidon2-evm (Foundry) ───────────────────────────────────────────────────
if [ -d "lib/poseidon2-evm" ]; then
  echo "[OK] poseidon2-evm already installed in lib/"
else
  echo "[INSTALL] Installing zemse/poseidon2-evm via forge..."
  forge install zemse/poseidon2-evm
  echo "[OK] poseidon2-evm installed"
fi

# ── @zkpassport/poseidon2 (TypeScript) ───────────────────────────────────────
if [ -d "node_modules/@zkpassport/poseidon2" ]; then
  echo "[OK] @zkpassport/poseidon2 already installed"
else
  echo "[INSTALL] Installing @zkpassport/poseidon2@${ZKPASSPORT_POSEIDON2_VERSION}..."
  bun add "@zkpassport/poseidon2@${ZKPASSPORT_POSEIDON2_VERSION}"
  echo "[OK] @zkpassport/poseidon2 installed"
fi

echo ""
echo "=== Running Stage 0 golden-vector gate ==="
echo ""

# Solidity gate
echo "[FORGE] Running Poseidon2GoldenVectorTest..."
forge test --match-contract Poseidon2GoldenVectorTest -v
echo ""

# TypeScript gate
echo "[BUN] Running poseidon.golden.test.ts..."
bun test sdk/test/poseidon.golden.test.ts
echo ""

echo "=== Stage 0 COMPLETE ==="
echo "All golden vectors match. Toolchain is ready for Stage 1."
