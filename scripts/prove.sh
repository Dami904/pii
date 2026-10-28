#!/usr/bin/env bash
# prove.sh <circuit-name> [proverName] [fixturePrefix]
# Full proof pipeline for a Pii circuit:
#   1. nargo execute  → witness
#   2. bb prove       → proof + VK
#   3. bb verify      → sanity check
#   4. bb write_solidity_verifier → contracts/verifiers/<Name>Verifier.sol
#   5. Copy proof + public_inputs → contracts/test/fixtures/<fixturePrefix>_*
#
# Usage:
#   bash scripts/prove.sh withdraw
#   bash scripts/prove.sh withdraw Prover_pool pool_withdraw   # uses Prover_pool.toml
#   bash scripts/prove.sh transfer Prover_e2e  e2e_transfer    # uses Prover_e2e.toml
#
# IMPORTANT: proverName MUST NOT contain a dot.  nargo treats the first dot as
# a file extension and silently falls back to Prover.toml, producing a wrong
# witness.  Always use underscores: Prover_e2e, Prover_pool, etc.

set -euo pipefail

CIRCUIT="${1:-}"
if [ -z "$CIRCUIT" ]; then
  echo "Usage: $0 <circuit-name> [proverName] [fixturePrefix]"
  exit 1
fi

PROVER_NAME="${2:-}"         # optional: passed as -p to nargo execute (no dots!)
FIXTURE_PREFIX="${3:-$CIRCUIT}"   # optional: prefix for fixture files (default: circuit name)

# Toolchain paths
export PATH="$HOME/.nargo/bin:$HOME/.bb:$HOME/.bun/bin:$PATH"

CIRCUIT_DIR="circuits/$CIRCUIT"
ARTIFACTS_DIR="$CIRCUIT_DIR/target"
PROOF_DIR="$ARTIFACTS_DIR/proof"
FIXTURES_DIR="contracts/test/fixtures"
VERIFIER_DIR="contracts/verifiers"
NAME="$(echo "${CIRCUIT:0:1}" | tr '[:lower:]' '[:upper:]')${CIRCUIT:1}"

mkdir -p "$PROOF_DIR" "$FIXTURES_DIR" "$VERIFIER_DIR"

echo "=== Step 1: nargo compile + execute ==="
# Use the prover name as the witness output name (no dots — already enforced by convention).
WITNESS_NAME="${PROVER_NAME:-witness}"

# Always remove the stale witness before running nargo execute so bb prove
# can never silently re-use an old witness.
rm -f "$ARTIFACTS_DIR/${WITNESS_NAME}.gz"

if [ -n "$PROVER_NAME" ]; then
  (cd "$CIRCUIT_DIR" && nargo compile && nargo execute -p "$PROVER_NAME" "$WITNESS_NAME")
else
  (cd "$CIRCUIT_DIR" && nargo compile && nargo execute witness)
fi
BYTECODE="$ARTIFACTS_DIR/$CIRCUIT.json"
WITNESS="$ARTIFACTS_DIR/${WITNESS_NAME}.gz"

echo "=== Step 2: bb prove (UltraHonk, EVM target) ==="
bb prove -b "$BYTECODE" -w "$WITNESS" -o "$PROOF_DIR" -t evm --write_vk

echo "=== Step 3: bb verify ==="
bb verify -k "$PROOF_DIR/vk" -p "$PROOF_DIR/proof" -i "$PROOF_DIR/public_inputs" -t evm
echo "bb verify: OK"

echo "=== Step 4: generate Solidity verifier ==="
VERIFIER_SOL="$VERIFIER_DIR/${NAME}Verifier.sol"
bb write_solidity_verifier -k "$PROOF_DIR/vk" -o "$VERIFIER_SOL" -t evm
sed -i "s/contract HonkVerifier/contract ${NAME}Verifier/g" "$VERIFIER_SOL"
sed -i "s/IHonkVerifier/I${NAME}Verifier/g" "$VERIFIER_SOL" || true
echo "Verifier written to $VERIFIER_SOL"

echo "=== Step 5: copy fixtures ==="
cp "$PROOF_DIR/proof"         "$FIXTURES_DIR/${FIXTURE_PREFIX}_proof.bin"
cp "$PROOF_DIR/public_inputs" "$FIXTURES_DIR/${FIXTURE_PREFIX}_public_inputs.bin"
cp "$PROOF_DIR/vk"            "$FIXTURES_DIR/${FIXTURE_PREFIX}_vk.bin"

PROOF_SIZE=$(wc -c < "$PROOF_DIR/proof")
echo ""
echo "Proof size:  $PROOF_SIZE bytes"
echo "Fixtures:    $FIXTURES_DIR/${FIXTURE_PREFIX}_proof.bin"
echo "             $FIXTURES_DIR/${FIXTURE_PREFIX}_public_inputs.bin"
echo ""
echo "=== Pipeline COMPLETE for $CIRCUIT (prover=${PROVER_NAME:-default}, prefix=${FIXTURE_PREFIX}) ==="
