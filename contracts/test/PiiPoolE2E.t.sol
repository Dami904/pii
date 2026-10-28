// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import "forge-std/Test.sol";
import {PiiPool}         from "../src/PiiPool.sol";
import {LibPiiHash}      from "../src/LibPiiHash.sol";
import {WithdrawVerifier} from "../verifiers/WithdrawVerifier.sol";
import {TransferVerifier} from "../verifiers/TransferVerifier.sol";

// Reuse MockERC20 from PiiPool.t.sol via a local copy so we don't import from a test file.
contract MockERC20E2E {
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;
    function mint(address to, uint256 amount) external { balanceOf[to] += amount; }
    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount; return true;
    }
    function transfer(address to, uint256 amount) external returns (bool) {
        require(balanceOf[msg.sender] >= amount, "insufficient");
        balanceOf[msg.sender] -= amount; balanceOf[to] += amount; return true;
    }
    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        require(balanceOf[from] >= amount, "insufficient");
        require(allowance[from][msg.sender] >= amount, "allowance");
        allowance[from][msg.sender] -= amount;
        balanceOf[from] -= amount; balanceOf[to] += amount; return true;
    }
}

// ── Constants from gen-e2e-fixture.ts output ──────────────────────────────────

contract PiiPoolE2ETest is Test {
    address constant USDC_ADDR = 0x3600000000000000000000000000000000000000;
    address constant POOL_ADDR = 0x0000000000000000000000000000000000001001;
    address constant OWNER     = address(0xABCD);
    address constant ALICE     = address(0xA11CE);
    address constant RELAYER   = address(0x000000000000000000000000000000000000FEE0);
    address constant RECIPIENT = address(0x000000000000000000000000000000000000bEEF);

    // ── Deposit params ────────────────────────────────────────────────────────
    // leaf 0: sk=7 blinding=11 amount=2_000_000
    // leaf 1: sk=7 blinding=12 amount=1_000_000
    // leaf 2: sk=7 blinding=13 amount=200_000 (fee note)
    uint256 constant SEC_A0  = 0; // computed in setUp
    uint256 constant SEC_A1  = 0;
    uint256 constant SEC_FEE = 0;

    // ── Golden values from gen-e2e-fixture.ts ─────────────────────────────────
    uint256 constant USDC_ID   = 0x07db0ab36b82e923f962dc97079a2321c10234f3faf2b14672413ffd3838d86e;
    uint256 constant CMT_A0    = 0x25401d063ca1ea2e93b060c3191f5221a54f9d52fd5e8f81e666d9d07d6aa812;
    uint256 constant CMT_A1    = 0x291c073c82e06e7981a792ed4a700d1ab55853111cb1f4c20b5a69e67fdc7c86;
    uint256 constant CMT_FEE   = 0x02589e958e1914010710d07839b95cda441ab5381b267cff8e5395f87eb2ca3d;
    uint256 constant ROOT_3    = 0x0e14666af22b282d457244bb3c6c825c2872c37748e30b120b74e9ed9b8364a2;
    uint256 constant NF0       = 0x02b1971abd74524aa9b7175b7689356d5268d4c7bbcd59c57594577e7ca28bf4;
    uint256 constant NF1       = 0x21774fd5719064deb939a8266e597e385ea6a44be87f56350c00aafff704b637;
    uint256 constant NF_FEE    = 0x1c6f8abd5bf2305b5a1925ef08dd290b042773f1c56ba2a85fe8350a40f74008;
    uint256 constant OUT_RECIP = 0x10c7132167488662b478551f5621750b5ac7154ae9d962a266dbede7681bc072;
    uint256 constant OUT_CHG   = 0x027bfe3dad0b995d2a93ddb4349d4f4dd6c7ad4a6552d6ae5f9e694c6608cf3d;
    uint256 constant OUT_FEE   = 0x27b49af6c3e50a44e47b74084da2b11939c3e2cf751340f282d50ceb40fa3a7f;
    uint256 constant OUT_FEE_CHG = 0x1e44673056bf3404c2bd09d3ef8fc25ea094d13da085dd4a5705b8359a592370;
    uint256 constant ROOT_AFTER_TRANSFER = 0x2e4650c96ea6622aa0a9bc0637936d5a096e9fb4193010c3d852e7861ce617bb;
    uint256 constant NFB       = 0x0d9ae79f04939e9a77ca1d0bde172b9f21e71ac5a780214b1d542861f4d4a2a0;
    uint256 constant OK_RELAYER = 0x06cb4824a064e10e1c65bba82631507dfc6883287fa218a918ab9454eba930cb; // owner_key(13)
    uint256 constant TRANSFER_FEE = 50_000;
    uint256 constant EMPTY_ROOT = 0x19ee29beb37701dd87b245c58cc348522c86f063f3aa049d19d6fddc71de23c7;
    uint256 constant EXT_TRANSFER = 0x2be643aa91018f442aed7fb75ccc97475133f2c319e516160a13f1e4c97f0486;
    uint256 constant EXT_WITHDRAW = 0x221997461d326839e985f996feb2d5146b442d714552ec2306f48d57360f0fcc;
    uint256 constant ZERO_VALUE = 0x10aa41cd532efb9f2b7337c3f588d65e4af1b6c5bc76a7faa5db259c06ec2466;

    // ── Contracts ─────────────────────────────────────────────────────────────
    MockERC20E2E     usdc;
    WithdrawVerifier wVerifier;
    TransferVerifier tVerifier;
    PiiPool          pool;

    // ── Proofs ────────────────────────────────────────────────────────────────
    bytes     transferProof;
    bytes32[] transferPub;   // 12 inputs
    bytes     withdrawProof;
    bytes32[] withdrawPub;   // 6 inputs

    // ── Secrets (computed in setUp) ───────────────────────────────────────────
    uint256 secA0;
    uint256 secA1;
    uint256 secFee;

    function setUp() public {
        wVerifier = new WithdrawVerifier();
        tVerifier = new TransferVerifier();

        MockERC20E2E impl = new MockERC20E2E();
        vm.etch(USDC_ADDR, address(impl).code);
        usdc = MockERC20E2E(USDC_ADDR);

        deployCodeTo(
            "PiiPool.sol:PiiPool",
            abi.encode(
                USDC_ADDR,
                address(wVerifier),
                address(tVerifier),
                OWNER,
                uint256(10_000_000),
                uint256(50_000_000)
            ),
            POOL_ADDR
        );
        pool = PiiPool(POOL_ADDR);

        // Compute deposit secrets
        uint256 okA = LibPiiHash.hash2(7, 0);
        secA0  = LibPiiHash.hash2(okA, 11);
        secA1  = LibPiiHash.hash2(okA, 12);
        secFee = LibPiiHash.hash2(okA, 13);

        // Load transfer proof (12 public inputs = 384 bytes)
        transferProof = vm.readFileBinary("contracts/test/fixtures/e2e_transfer_proof.bin");
        {
            bytes memory raw = vm.readFileBinary("contracts/test/fixtures/e2e_transfer_public_inputs.bin");
            transferPub = new bytes32[](12);
            for (uint256 i = 0; i < 12; i++) {
                bytes32 w;
                assembly { w := mload(add(add(raw, 0x20), mul(i, 0x20))) }
                transferPub[i] = w;
            }
        }

        // Load withdraw proof (6 public inputs = 192 bytes)
        withdrawProof = vm.readFileBinary("contracts/test/fixtures/e2e_withdraw_proof.bin");
        {
            bytes memory raw = vm.readFileBinary("contracts/test/fixtures/e2e_withdraw_public_inputs.bin");
            withdrawPub = new bytes32[](6);
            for (uint256 i = 0; i < 6; i++) {
                bytes32 w;
                assembly { w := mload(add(add(raw, 0x20), mul(i, 0x20))) }
                withdrawPub[i] = w;
            }
        }
    }

    // ── Helper: deposit 3 leaves ──────────────────────────────────────────────

    function _dummyMemo() internal pure returns (bytes memory) { return new bytes(134); }

    function _deposit3() internal {
        uint256[3] memory amounts = [uint256(2_000_000), 1_000_000, 200_000];
        uint256[3] memory secrets = [secA0, secA1, secFee];
        uint256[3] memory cmts    = [CMT_A0, CMT_A1, CMT_FEE];
        for (uint256 i = 0; i < 3; i++) {
            usdc.mint(ALICE, amounts[i]);
            vm.prank(ALICE);
            usdc.approve(POOL_ADDR, amounts[i]);
            vm.prank(ALICE);
            pool.deposit(amounts[i], secrets[i], _dummyMemo());
            // Verify commitment matches golden
            assertEq(LibPiiHash.noteCommitment(USDC_ID, amounts[i], secrets[i]), cmts[i],
                "deposit cmt mismatch");
        }
        assertEq(pool.currentRoot(), ROOT_3, "root after 3 deposits");
    }

    // ── Helper: build TransferArgs ────────────────────────────────────────────

    function _transferArgs() internal pure returns (PiiPool.TransferArgs memory) {
        return PiiPool.TransferArgs({
            root:            ROOT_3,
            nf0:             NF0,
            nf1:             NF1,
            nfFee:           NF_FEE,
            outRecipient:    OUT_RECIP,
            outChange:       OUT_CHG,
            outFee:          OUT_FEE,
            outFeeChange:    OUT_FEE_CHG,
            eligibilityRoot: EMPTY_ROOT,
            fee:             TRANSFER_FEE,
            relayerOwnerKey: OK_RELAYER
        });
    }

    // ── Helper: build 4 transfer memos ───────────────────────────────────────

    function _transferMemos() internal pure returns (bytes[] memory) {
        bytes[] memory m = new bytes[](4);
        m[0] = hex"aa01"; m[1] = hex"aa02"; m[2] = hex"aa03"; m[3] = hex"aa04";
        return m;
    }

    // ── Helper: do the transfer ───────────────────────────────────────────────

    function _doTransfer() internal {
        pool.transfer(transferProof, _transferArgs(), RELAYER, _transferMemos());
    }

    // ── Helper: B's withdraw ──────────────────────────────────────────────────

    function _doWithdraw() internal {
        bytes[] memory memos = new bytes[](1);
        memos[0] = hex"bb01";
        pool.withdraw(withdrawProof, ROOT_AFTER_TRANSFER, NFB, RECIPIENT, 2_500_000, ZERO_VALUE, address(0), 0, memos);
    }

    // =========================================================================
    // (a) Full flow: 3 deposits → transfer → B's withdraw
    // =========================================================================

    function test_full_e2e_flow() public {
        // ── 3 deposits ────────────────────────────────────────────────────────
        _deposit3();
        assertEq(usdc.balanceOf(POOL_ADDR), 3_200_000, "pool balance after deposits");

        // ── Transfer ──────────────────────────────────────────────────────────
        uint256 gasBefore = gasleft();
        _doTransfer();
        uint256 gasUsed = gasBefore - gasleft();
        emit log_named_uint("transfer() gas", gasUsed);

        // Root advanced to post-transfer root
        assertEq(pool.currentRoot(), ROOT_AFTER_TRANSFER, "root after transfer");

        // Output leaves inserted at 3–6
        assertTrue(pool.isKnownRoot(ROOT_AFTER_TRANSFER), "post-transfer root known");

        // Nullifiers spent
        assertTrue(pool.nullifierSpent(NF0),    "nf0 spent");
        assertTrue(pool.nullifierSpent(NF1),    "nf1 spent");
        assertTrue(pool.nullifierSpent(NF_FEE), "nfFee spent");

        // ── B's withdraw ──────────────────────────────────────────────────────
        _doWithdraw();

        // bEEF receives 2.5M
        assertEq(usdc.balanceOf(RECIPIENT), 2_500_000, "bEEF balance");

        // Pool balance: deposited 3.2M, withdrew 2.5M
        assertEq(usdc.balanceOf(POOL_ADDR), 700_000, "pool balance after withdraw");

        assertTrue(pool.nullifierSpent(NFB), "nfB spent");
    }

    // =========================================================================
    // (b) Transfer double spend
    // =========================================================================

    function test_transfer_double_spend_reverts() public {
        _deposit3();
        _doTransfer();
        vm.expectRevert(PiiPool.NullifierSpent.selector);
        _doTransfer();
    }

    // =========================================================================
    // (c) Changed memo or relayer reverts
    // =========================================================================

    function test_transfer_changed_memo_reverts() public {
        _deposit3();
        bytes[] memory badMemos = _transferMemos();
        badMemos[0] = hex"dead";
        vm.expectRevert(PiiPool.ProofInvalid.selector);
        pool.transfer(transferProof, _transferArgs(), RELAYER, badMemos);
    }

    function test_transfer_changed_relayer_reverts() public {
        _deposit3();
        vm.expectRevert(PiiPool.ProofInvalid.selector);
        pool.transfer(transferProof, _transferArgs(), address(0xBAD), _transferMemos());
    }

    // =========================================================================
    // (d) eligibilityRoot != emptyRoot reverts
    // =========================================================================

    function test_transfer_wrong_eligibility_root_reverts() public {
        _deposit3();
        PiiPool.TransferArgs memory args = _transferArgs();
        args.eligibilityRoot = uint256(keccak256("fake_root")) % type(uint128).max;
        vm.expectRevert(PiiPool.EligibilityRootMismatch.selector);
        pool.transfer(transferProof, args, RELAYER, _transferMemos());
    }

    // =========================================================================
    // (e) Withdraw against B's note BEFORE transfer root exists reverts
    // =========================================================================

    function test_withdraw_before_transfer_root_reverts() public {
        _deposit3();
        // ROOT_AFTER_TRANSFER is not yet known
        bytes[] memory memos = new bytes[](1);
        memos[0] = hex"bb01";
        vm.expectRevert(PiiPool.UnknownRoot.selector);
        pool.withdraw(withdrawProof, ROOT_AFTER_TRANSFER, NFB, RECIPIENT, 2_500_000, ZERO_VALUE, address(0), 0, memos);
    }

    // =========================================================================
    // (f) Replay of B's withdraw reverts
    // =========================================================================

    function test_withdraw_replay_reverts() public {
        _deposit3();
        _doTransfer();
        _doWithdraw();
        vm.expectRevert(PiiPool.NullifierSpent.selector);
        _doWithdraw();
    }
}
