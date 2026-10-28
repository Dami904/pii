// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import "forge-std/Test.sol";
import {PiiPool}   from "../src/PiiPool.sol";
import {LibPiiHash} from "../src/LibPiiHash.sol";
import {WithdrawVerifier}  from "../verifiers/WithdrawVerifier.sol";
import {TransferVerifier}  from "../verifiers/TransferVerifier.sol";

// ── Minimal mock ERC-20 ───────────────────────────────────────────────────────
// Etched at the USDC address so PiiPool can call safeTransferFrom / transfer.
contract MockERC20 {
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    function mint(address to, uint256 amount) external {
        balanceOf[to] += amount;
    }
    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        return true;
    }
    function transfer(address to, uint256 amount) external returns (bool) {
        require(balanceOf[msg.sender] >= amount, "insufficient");
        balanceOf[msg.sender] -= amount;
        balanceOf[to] += amount;
        return true;
    }
    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        require(balanceOf[from] >= amount, "insufficient");
        require(allowance[from][msg.sender] >= amount, "allowance");
        allowance[from][msg.sender] -= amount;
        balanceOf[from] -= amount;
        balanceOf[to] += amount;
        return true;
    }
}

// ── Constants from gen-pool-fixture.ts ────────────────────────────────────────
// USDC = 0x3600000000000000000000000000000000000000
// POOL = 0x0000000000000000000000000000000000001001
// ZERO_VALUE = keccak256("pii-shielded-pool-v1") % r

contract PiiPoolTest is Test {
    // ── Addresses ─────────────────────────────────────────────────────────────
    address constant USDC_ADDR = 0x3600000000000000000000000000000000000000;
    address constant POOL_ADDR = 0x0000000000000000000000000000000000001001;
    address constant OWNER     = address(0xABCD);
    address constant ALICE     = address(0xA11CE);
    address constant RECIPIENT = address(0x000000000000000000000000000000000000bEEF);
    address constant RELAYER   = address(0x000000000000000000000000000000000000FEE0);

    // ── Fixture values from gen-pool-fixture.ts ───────────────────────────────
    uint256 constant DEPOSIT_AMOUNT   = 5_000_000;
    // These are the exact golden values from gen-pool-fixture.ts output:
    uint256 constant DEPOSIT_CMT      = 0x2a6a716a5ab0135e358ecfb1ecb5c6a0fd2070b7d3006582d7576cae6237db95;
    uint256 constant MERKLE_ROOT_1    = 0x25a8b35f51ca940b75a9423e1a3768f36f2185f8b96557b39c46e0a0b5617973;
    uint256 constant NULLIFIER        = 0x1d6152680d9714df203f54c490dfc2228af3f3f44713efbb881bb7b9b5100e57;
    uint256 constant WITHDRAW_AMOUNT  = 3_000_000;
    uint256 constant CHANGE_CMT       = 0x27859b061a335c2e02318ee01d11fe50d974bf3e7bdae83ed375562eb518a7dd;
    uint256 constant EXT_DATA_HASH    = 0x2e38723a8e79836cbeea3eb7abc0a61e1a9e3ee63f7747382636aff9bc5bdcbc;
    uint256 constant FEE              = 100_000;
    uint256 constant ZERO_VALUE       = 0x10aa41cd532efb9f2b7337c3f588d65e4af1b6c5bc76a7faa5db259c06ec2466;
    // USDC_ID = hash2(uint160(USDC_ADDR), 0)
    uint256 constant USDC_ID          = 0x07db0ab36b82e923f962dc97079a2321c10234f3faf2b14672413ffd3838d86e;

    // ── Contracts ─────────────────────────────────────────────────────────────
    MockERC20        usdc;
    WithdrawVerifier withdrawVerifier;
    TransferVerifier transferVerifier;
    PiiPool          pool;

    // ── Proof / public inputs loaded from fixtures ────────────────────────────
    bytes       proof;
    bytes32[]   pubInputs;

    // ── Memos matching the fixture ─────────────────────────────────────────────
    bytes[] memos;

    function setUp() public {
        // 1. Deploy verifiers
        withdrawVerifier = new WithdrawVerifier();
        transferVerifier = new TransferVerifier();

        // 2. Etch MockERC20 at the USDC address
        MockERC20 impl = new MockERC20();
        vm.etch(USDC_ADDR, address(impl).code);
        usdc = MockERC20(USDC_ADDR);

        // 3. Deploy pool at 0x…1001 so chainid+address match the proof fixture.
        deployCodeTo(
            "PiiPool.sol:PiiPool",
            abi.encode(
                USDC_ADDR,
                address(withdrawVerifier),
                address(transferVerifier),
                OWNER,
                uint256(10_000_000),  // maxDeposit  = 10 USDC
                uint256(50_000_000)   // maxPoolBalance = 50 USDC
            ),
            POOL_ADDR
        );
        pool = PiiPool(POOL_ADDR);

        // 4. Load proof and public inputs from fixtures
        proof = vm.readFileBinary("contracts/test/fixtures/pool_withdraw_proof.bin");
        bytes memory rawPub = vm.readFileBinary("contracts/test/fixtures/pool_withdraw_public_inputs.bin");
        // 6 public inputs × 32 bytes = 192 bytes
        pubInputs = new bytes32[](6);
        for (uint256 i = 0; i < 6; i++) {
            bytes32 w;
            assembly { w := mload(add(add(rawPub, 0x20), mul(i, 0x20))) }
            pubInputs[i] = w;
        }

        // 5. Memo: [0xc0ffee]
        memos = new bytes[](1);
        memos[0] = hex"c0ffee";
    }

    // ── Helper: compute secret = hash2(owner_key(7), 999) in Solidity ─────────
    function _depositSecret() internal pure returns (uint256) {
        uint256 ownerKey = LibPiiHash.hash2(7, 0);
        return LibPiiHash.hash2(ownerKey, 999);
    }

    // ── Helper: 134-byte dummy memo ───────────────────────────────────────────
    function _dummyMemo() internal pure returns (bytes memory) {
        return new bytes(134);
    }

    // ── Helper: mint + approve + deposit ──────────────────────────────────────
    function _doDeposit(address user, uint256 amount, uint256 secret) internal {
        usdc.mint(user, amount);
        vm.prank(user);
        usdc.approve(POOL_ADDR, amount);
        vm.prank(user);
        pool.deposit(amount, secret, _dummyMemo());
    }

    // =========================================================================
    // (a) Deposit: leaf equals hash3(USDC_ID, amount, secret), root becomes known
    // =========================================================================

    function test_deposit_commitment_and_root() public {
        uint256 secret = _depositSecret();
        uint256 expectedCmt = LibPiiHash.noteCommitment(USDC_ID, DEPOSIT_AMOUNT, secret);
        assertEq(expectedCmt, DEPOSIT_CMT, "commitment mismatch vs golden");

        _doDeposit(ALICE, DEPOSIT_AMOUNT, secret);

        assertEq(pool.nextIndex(), 1, "nextIndex should be 1");
        assertTrue(pool.isKnownRoot(MERKLE_ROOT_1), "1-leaf root not recorded");
        assertEq(usdc.balanceOf(POOL_ADDR), DEPOSIT_AMOUNT, "pool balance mismatch");
    }

    // =========================================================================
    // (b) Real-proof withdraw: balances, change leaf, nullifier spent, gas
    // =========================================================================

    function test_withdraw_real_proof() public {
        uint256 secret = _depositSecret();
        _doDeposit(ALICE, DEPOSIT_AMOUNT, secret);

        uint256 gasBefore = gasleft();
        pool.withdraw(
            proof,
            MERKLE_ROOT_1,
            NULLIFIER,
            RECIPIENT,
            WITHDRAW_AMOUNT,
            CHANGE_CMT,
            RELAYER,
            FEE,
            memos
        );
        uint256 gasUsed = gasBefore - gasleft();
        emit log_named_uint("withdraw() gas", gasUsed);

        // Recipient gets amount - fee
        assertEq(usdc.balanceOf(RECIPIENT), WITHDRAW_AMOUNT - FEE, "recipient balance");
        // Relayer gets fee
        assertEq(usdc.balanceOf(RELAYER), FEE, "relayer fee");
        // Nullifier spent
        assertTrue(pool.nullifierSpent(NULLIFIER), "nullifier not spent");
        // Change leaf inserted at index 1
        assertEq(pool.nextIndex(), 2, "change leaf not inserted");
        // Pool holds only the change (2_000_000)
        assertEq(usdc.balanceOf(POOL_ADDR), DEPOSIT_AMOUNT - WITHDRAW_AMOUNT, "pool residual");
    }

    // =========================================================================
    // (c) Double spend reverts
    // =========================================================================

    function test_double_spend_reverts() public {
        uint256 secret = _depositSecret();
        _doDeposit(ALICE, DEPOSIT_AMOUNT, secret);
        pool.withdraw(proof, MERKLE_ROOT_1, NULLIFIER, RECIPIENT, WITHDRAW_AMOUNT,
                      CHANGE_CMT, RELAYER, FEE, memos);
        vm.expectRevert(PiiPool.NullifierSpent.selector);
        pool.withdraw(proof, MERKLE_ROOT_1, NULLIFIER, RECIPIENT, WITHDRAW_AMOUNT,
                      CHANGE_CMT, RELAYER, FEE, memos);
    }

    // =========================================================================
    // (d) ext_data_hash: tampered fields revert
    // =========================================================================

    function test_tamper_relayer_reverts() public {
        uint256 secret = _depositSecret();
        _doDeposit(ALICE, DEPOSIT_AMOUNT, secret);
        vm.expectRevert(PiiPool.ProofInvalid.selector);
        pool.withdraw(proof, MERKLE_ROOT_1, NULLIFIER, RECIPIENT, WITHDRAW_AMOUNT,
                      CHANGE_CMT, address(0xBAD), FEE, memos);
    }

    function test_tamper_fee_reverts() public {
        uint256 secret = _depositSecret();
        _doDeposit(ALICE, DEPOSIT_AMOUNT, secret);
        vm.expectRevert(PiiPool.ProofInvalid.selector);
        pool.withdraw(proof, MERKLE_ROOT_1, NULLIFIER, RECIPIENT, WITHDRAW_AMOUNT,
                      CHANGE_CMT, RELAYER, FEE + 1, memos);
    }

    function test_tamper_recipient_reverts() public {
        uint256 secret = _depositSecret();
        _doDeposit(ALICE, DEPOSIT_AMOUNT, secret);
        vm.expectRevert(PiiPool.ProofInvalid.selector);
        pool.withdraw(proof, MERKLE_ROOT_1, NULLIFIER, address(0xDEAD), WITHDRAW_AMOUNT,
                      CHANGE_CMT, RELAYER, FEE, memos);
    }

    function test_tamper_memo_reverts() public {
        uint256 secret = _depositSecret();
        _doDeposit(ALICE, DEPOSIT_AMOUNT, secret);
        bytes[] memory badMemos = new bytes[](1);
        badMemos[0] = hex"deadbeef";
        vm.expectRevert(PiiPool.ProofInvalid.selector);
        pool.withdraw(proof, MERKLE_ROOT_1, NULLIFIER, RECIPIENT, WITHDRAW_AMOUNT,
                      CHANGE_CMT, RELAYER, FEE, badMemos);
    }

    // =========================================================================
    // (e) Unknown root reverts
    // =========================================================================

    function test_unknown_root_reverts() public {
        uint256 secret = _depositSecret();
        _doDeposit(ALICE, DEPOSIT_AMOUNT, secret);
        vm.expectRevert(PiiPool.UnknownRoot.selector);
        pool.withdraw(proof, uint256(0xDEAD), NULLIFIER, RECIPIENT, WITHDRAW_AMOUNT,
                      CHANGE_CMT, RELAYER, FEE, memos);
    }

    // =========================================================================
    // (f) DRAIN ATTACK: deposit 1 atom, tampered proof (amount = 10^12) reverts
    // =========================================================================

    function test_drain_attack_reverts() public {
        // Deposit 5M normally to populate the root (the proof expects MERKLE_ROOT_1)
        uint256 secret = _depositSecret();
        _doDeposit(ALICE, DEPOSIT_AMOUNT, secret);

        // Attacker submits the real 3M-withdrawal proof but inflates amount to 10^12.
        // The public inputs won't match the proof → verifier reverts → ProofInvalid.
        uint256 drainAmount = 1_000_000_000_000;
        vm.expectRevert(PiiPool.ProofInvalid.selector);
        pool.withdraw(proof, MERKLE_ROOT_1, NULLIFIER, RECIPIENT, drainAmount,
                      CHANGE_CMT, RELAYER, FEE, memos);

        // Pool balance unchanged
        assertEq(usdc.balanceOf(POOL_ADDR), DEPOSIT_AMOUNT, "pool drained");
    }

    // =========================================================================
    // (g) Caps: over maxDeposit and over maxPoolBalance revert
    // =========================================================================

    function test_over_max_deposit_reverts() public {
        uint256 tooMuch = 10_000_001; // > maxDeposit (10_000_000)
        usdc.mint(ALICE, tooMuch);
        vm.prank(ALICE); usdc.approve(POOL_ADDR, tooMuch);
        vm.prank(ALICE);
        vm.expectRevert(PiiPool.ExceedsMaxDeposit.selector);
        pool.deposit(tooMuch, 1234, _dummyMemo());
    }

    function test_over_max_pool_balance_reverts() public {
        // Lower the pool cap to 8_000_000 so two 5M deposits exceed it.
        vm.prank(OWNER);
        pool.setCaps(10_000_000, 8_000_000);

        // First deposit of 5M succeeds
        uint256 secretBase = LibPiiHash.hash2(LibPiiHash.hash2(1, 0), 100);
        _doDeposit(ALICE, 5_000_000, secretBase);
        assertEq(usdc.balanceOf(POOL_ADDR), 5_000_000);

        // Second deposit of 5M would push to 10M > 8M cap => revert
        usdc.mint(ALICE, 5_000_000);
        vm.prank(ALICE); usdc.approve(POOL_ADDR, 5_000_000);
        vm.prank(ALICE);
        vm.expectRevert(PiiPool.ExceedsMaxPoolBalance.selector);
        pool.deposit(5_000_000, LibPiiHash.hash2(secretBase, 1), _dummyMemo());
    }

    // =========================================================================
    // (h) Pause: deposits blocked, withdraw still works
    // =========================================================================

    function test_pause_blocks_deposit_not_withdraw() public {
        uint256 secret = _depositSecret();
        _doDeposit(ALICE, DEPOSIT_AMOUNT, secret);

        // Pause
        vm.prank(OWNER);
        pool.setDepositsPaused(true);

        // Deposit should revert
        usdc.mint(ALICE, 1_000_000);
        vm.prank(ALICE); usdc.approve(POOL_ADDR, 1_000_000);
        vm.prank(ALICE);
        vm.expectRevert(PiiPool.DepositsPaused.selector);
        pool.deposit(1_000_000, 9999, _dummyMemo());

        // Withdraw should still succeed
        pool.withdraw(proof, MERKLE_ROOT_1, NULLIFIER, RECIPIENT, WITHDRAW_AMOUNT,
                      CHANGE_CMT, RELAYER, FEE, memos);
        assertEq(usdc.balanceOf(RECIPIENT), WITHDRAW_AMOUNT - FEE);
    }

    // =========================================================================
    // (i) Non-owner cannot set caps or pause
    // =========================================================================

    function test_non_owner_cannot_set_caps() public {
        vm.prank(ALICE);
        vm.expectRevert();
        pool.setCaps(1, 1);
    }

    function test_non_owner_cannot_pause() public {
        vm.prank(ALICE);
        vm.expectRevert();
        pool.setDepositsPaused(true);
    }
}
