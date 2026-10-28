// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

// Targeted mutation-kill tests for PiiPool guards.
// Each test is structured so it PASSES with the real contract and
// FAILS (does not revert where it should) if exactly one guard is removed.
//
// Most deposit/transfer guards fire before proof verification, so fake
// proof bytes are acceptable there.

import "forge-std/Test.sol";
import {PiiPool}          from "../src/PiiPool.sol";
import {PiiMerkle}        from "../src/PiiMerkle.sol";
import {LibPiiHash}       from "../src/LibPiiHash.sol";
import {WithdrawVerifier} from "../verifiers/WithdrawVerifier.sol";
import {TransferVerifier} from "../verifiers/TransferVerifier.sol";

// ── Minimal mock ERC-20 ───────────────────────────────────────────────────────
contract MockERC20G {
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;
    function mint(address to, uint256 amt) external { balanceOf[to] += amt; }
    function approve(address sp, uint256 amt) external returns (bool) {
        allowance[msg.sender][sp] = amt; return true;
    }
    function transfer(address to, uint256 amt) external returns (bool) {
        require(balanceOf[msg.sender] >= amt); balanceOf[msg.sender] -= amt; balanceOf[to] += amt; return true;
    }
    function transferFrom(address fr, address to, uint256 amt) external returns (bool) {
        require(balanceOf[fr] >= amt); require(allowance[fr][msg.sender] >= amt);
        allowance[fr][msg.sender] -= amt; balanceOf[fr] -= amt; balanceOf[to] += amt; return true;
    }
}

// ── Harness: exposes _insertOutput for sentinel skip test ────────────────────
// Inherits PiiPool's full logic; adds a public wrapper for _insertOutput.
contract PiiPoolHarness is PiiPool {
    constructor(
        address usdc_, address wv_, address tv_,
        address owner_, uint256 maxD_, uint256 maxP_
    ) PiiPool(usdc_, wv_, tv_, owner_, maxD_, maxP_) {}

    /// @dev Expose _insertOutput for testing the ZERO_VALUE skip.
    function insertOutputPub(uint256 commitment, bytes calldata memo) external {
        _insertOutput(commitment, memo);
    }

    /// @dev Returns nextIndex so callers don't need tree access.
    function nextIdx() external view returns (uint256) {
        return this.nextIndex();
    }
}

// ─────────────────────────────────────────────────────────────────────────────

contract PiiPoolGuardsTest is Test {
    address constant USDC_ADDR = 0x3600000000000000000000000000000000000000;
    address constant POOL_ADDR = 0x0000000000000000000000000000000000001001;
    address constant OWNER     = address(0xABCD);
    address constant ALICE     = address(0xA11CE);
    address constant RECIPIENT = address(0x000000000000000000000000000000000000bEEF);
    address constant RELAYER   = address(0x000000000000000000000000000000000000FEE0);

    uint256 constant ZERO_VALUE =
        0x10aa41cd532efb9f2b7337c3f588d65e4af1b6c5bc76a7faa5db259c06ec2466;
    uint256 constant BN254_R =
        0x30644e72e131a029b85045b68181585d2833e84879b9709143e1f593f0000001;
    uint256 constant EMPTY_ROOT =
        0x19ee29beb37701dd87b245c58cc348522c86f063f3aa049d19d6fddc71de23c7;
    uint256 constant USDC_ID =
        0x07db0ab36b82e923f962dc97079a2321c10234f3faf2b14672413ffd3838d86e;

    MockERC20G       usdc;
    WithdrawVerifier wVerifier;
    TransferVerifier tVerifier;
    PiiPool          pool;
    PiiPoolHarness   harness;

    // E2E withdraw proof (fee=0, change=ZERO_VALUE) for sentinel skip test
    bytes       e2eWithdrawProof;
    bytes32[]   e2eWithdrawPub;   // [root, nf, recip, amount, ZERO_VALUE, ext]

    // Pool-fixture withdraw proof (real, for RelayerZero / FeeExceedsAmount tests)
    bytes       poolProof;
    bytes32[]   poolPub;

    // E2E golden values
    uint256 constant NFB              = 0x0d9ae79f04939e9a77ca1d0bde172b9f21e71ac5a780214b1d542861f4d4a2a0;
    uint256 constant ROOT_AFTER_XFER  = 0x2e4650c96ea6622aa0a9bc0637936d5a096e9fb4193010c3d852e7861ce617bb;
    uint256 constant CMT_A0 = 0x25401d063ca1ea2e93b060c3191f5221a54f9d52fd5e8f81e666d9d07d6aa812;
    uint256 constant CMT_A1 = 0x291c073c82e06e7981a792ed4a700d1ab55853111cb1f4c20b5a69e67fdc7c86;
    uint256 constant CMT_FEE_DEP = 0x02589e958e1914010710d07839b95cda441ab5381b267cff8e5395f87eb2ca3d;
    uint256 constant NF0 = 0x02b1971abd74524aa9b7175b7689356d5268d4c7bbcd59c57594577e7ca28bf4;
    uint256 constant NF1 = 0x21774fd5719064deb939a8266e597e385ea6a44be87f56350c00aafff704b637;
    uint256 constant NF_FEE_XFER = 0x1c6f8abd5bf2305b5a1925ef08dd290b042773f1c56ba2a85fe8350a40f74008;
    uint256 constant OUT_RECIP    = 0x10c7132167488662b478551f5621750b5ac7154ae9d962a266dbede7681bc072;
    uint256 constant OUT_CHG      = 0x027bfe3dad0b995d2a93ddb4349d4f4dd6c7ad4a6552d6ae5f9e694c6608cf3d;
    uint256 constant OUT_FEE      = 0x27b49af6c3e50a44e47b74084da2b11939c3e2cf751340f282d50ceb40fa3a7f;
    uint256 constant OUT_FEE_CHG  = 0x1e44673056bf3404c2bd09d3ef8fc25ea094d13da085dd4a5705b8359a592370;
    uint256 constant ROOT_3       = 0x0e14666af22b282d457244bb3c6c825c2872c37748e30b120b74e9ed9b8364a2;
    uint256 constant OK_RELAYER   = 0x06cb4824a064e10e1c65bba82631507dfc6883287fa218a918ab9454eba930cb;
    uint256 constant TRANSFER_FEE = 50_000;

    // Pool-fixture constants
    uint256 constant POOL_ROOT        = 0x25a8b35f51ca940b75a9423e1a3768f36f2185f8b96557b39c46e0a0b5617973;
    uint256 constant POOL_NF          = 0x1d6152680d9714df203f54c490dfc2228af3f3f44713efbb881bb7b9b5100e57;
    uint256 constant POOL_DEPOSIT_AMT = 5_000_000;
    uint256 constant POOL_WITHDRAW_AMT = 3_000_000;
    uint256 constant POOL_CHANGE_CMT   = 0x27859b061a335c2e02318ee01d11fe50d974bf3e7bdae83ed375562eb518a7dd;
    uint256 constant POOL_FEE          = 100_000;

    function setUp() public {
        wVerifier = new WithdrawVerifier();
        tVerifier = new TransferVerifier();

        MockERC20G impl = new MockERC20G();
        vm.etch(USDC_ADDR, address(impl).code);
        usdc = MockERC20G(USDC_ADDR);

        // Deploy pool at canonical address (chainid + address match pool fixture)
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

        // Deploy harness at a different address (for harness-specific tests)
        harness = new PiiPoolHarness(
            USDC_ADDR,
            address(wVerifier),
            address(tVerifier),
            OWNER,
            uint256(100_000_000),
            uint256(500_000_000)
        );

        // Load pool-fixture withdraw proof
        poolProof = vm.readFileBinary("contracts/test/fixtures/pool_withdraw_proof.bin");
        bytes memory rawPool = vm.readFileBinary("contracts/test/fixtures/pool_withdraw_public_inputs.bin");
        poolPub = new bytes32[](6);
        for (uint256 i = 0; i < 6; i++) {
            bytes32 w; assembly { w := mload(add(add(rawPool, 0x20), mul(i, 0x20))) }
            poolPub[i] = w;
        }

        // Load E2E withdraw proof (fee=0, change=ZERO_VALUE)
        e2eWithdrawProof = vm.readFileBinary("contracts/test/fixtures/e2e_withdraw_proof.bin");
        bytes memory rawE2E = vm.readFileBinary("contracts/test/fixtures/e2e_withdraw_public_inputs.bin");
        e2eWithdrawPub = new bytes32[](6);
        for (uint256 i = 0; i < 6; i++) {
            bytes32 w; assembly { w := mload(add(add(rawE2E, 0x20), mul(i, 0x20))) }
            e2eWithdrawPub[i] = w;
        }
    }

    // ── helpers ───────────────────────────────────────────────────────────────

    function _poolDepositSecret() internal pure returns (uint256) {
        return LibPiiHash.hash2(LibPiiHash.hash2(7, 0), 999);
    }

    function _dummyMemo() internal pure returns (bytes memory) {
        return new bytes(134);
    }

    function _poolDeposit() internal {
        uint256 secret = _poolDepositSecret();
        usdc.mint(ALICE, POOL_DEPOSIT_AMT);
        vm.prank(ALICE); usdc.approve(POOL_ADDR, POOL_DEPOSIT_AMT);
        vm.prank(ALICE); pool.deposit(POOL_DEPOSIT_AMT, secret, _dummyMemo());
    }

    function _poolMemos() internal pure returns (bytes[] memory m) {
        m = new bytes[](1); m[0] = hex"c0ffee";
    }

    function _e2eDeposit3() internal {
        uint256 okA = LibPiiHash.hash2(7, 0);
        uint256[3] memory amts = [uint256(2_000_000), 1_000_000, 200_000];
        uint256[3] memory secs = [LibPiiHash.hash2(okA, 11), LibPiiHash.hash2(okA, 12), LibPiiHash.hash2(okA, 13)];
        for (uint256 i = 0; i < 3; i++) {
            usdc.mint(ALICE, amts[i]);
            vm.prank(ALICE); usdc.approve(POOL_ADDR, amts[i]);
            vm.prank(ALICE); pool.deposit(amts[i], secs[i], _dummyMemo());
        }
    }

    // Load and execute the E2E transfer so ROOT_AFTER_XFER becomes a known root.
    function _e2eTransfer() internal {
        bytes memory tProof = vm.readFileBinary("contracts/test/fixtures/e2e_transfer_proof.bin");
        PiiPool.TransferArgs memory a = PiiPool.TransferArgs({
            root:            ROOT_3,
            nf0:             NF0,
            nf1:             NF1,
            nfFee:           NF_FEE_XFER,
            outRecipient:    OUT_RECIP,
            outChange:       OUT_CHG,
            outFee:          OUT_FEE,
            outFeeChange:    OUT_FEE_CHG,
            eligibilityRoot: EMPTY_ROOT,
            fee:             TRANSFER_FEE,
            relayerOwnerKey: OK_RELAYER
        });
        bytes[] memory m = new bytes[](4);
        m[0] = hex"aa01"; m[1] = hex"aa02"; m[2] = hex"aa03"; m[3] = hex"aa04";
        pool.transfer(tProof, a, RELAYER, m);
    }

    function _e2eWithdrawMemos() internal pure returns (bytes[] memory m) {
        m = new bytes[](1); m[0] = hex"bb01";
    }

    // =========================================================================
    // DEPOSIT guards
    // =========================================================================

    // Guard: `if (amount == 0) revert AmountZero()`
    function test_deposit_amount_zero() public {
        vm.expectRevert(PiiPool.AmountZero.selector);
        vm.prank(ALICE);
        pool.deposit(0, 12345, _dummyMemo());
    }

    // Guard: `if (amount >= (1 << 64)) revert AmountTooLarge()`
    // Raise caps so ExceedsMaxDeposit doesn't fire first.
    function test_deposit_amount_too_large() public {
        vm.prank(OWNER);
        pool.setCaps(type(uint256).max, type(uint256).max);

        uint256 huge = 1 << 64;
        usdc.mint(ALICE, huge);
        vm.prank(ALICE); usdc.approve(POOL_ADDR, huge);
        vm.prank(ALICE);
        vm.expectRevert(PiiPool.AmountTooLarge.selector);
        pool.deposit(huge, 12345, _dummyMemo());
    }

    // Guard: `if (secret >= BN254_R) revert SecretOutOfField()`
    // secret == r (exactly the modulus) must revert.
    function test_deposit_secret_out_of_field() public {
        usdc.mint(ALICE, 1_000_000);
        vm.prank(ALICE); usdc.approve(POOL_ADDR, 1_000_000);
        vm.prank(ALICE);
        vm.expectRevert(PiiPool.SecretOutOfField.selector);
        pool.deposit(1_000_000, BN254_R, _dummyMemo());
    }

    // Guard: `if (memo.length != MEMO_LENGTH) revert BadMemo()`
    function test_deposit_bad_memo_length() public {
        usdc.mint(ALICE, 1_000_000);
        vm.prank(ALICE); usdc.approve(POOL_ADDR, 1_000_000);
        uint256 secret = LibPiiHash.hash2(LibPiiHash.hash2(7, 0), 1);
        vm.prank(ALICE);
        vm.expectRevert(PiiPool.BadMemo.selector);
        pool.deposit(1_000_000, secret, hex"cafe"); // 2 bytes != 134
    }

    // =========================================================================
    // WITHDRAW guards
    // =========================================================================

    // Guard: `if (recipient == address(0)) revert RecipientZero()`
    function test_withdraw_recipient_zero() public {
        _poolDeposit();
        vm.expectRevert(PiiPool.RecipientZero.selector);
        pool.withdraw(poolProof, POOL_ROOT, POOL_NF, address(0),
                      POOL_WITHDRAW_AMT, POOL_CHANGE_CMT, RELAYER, POOL_FEE, _poolMemos());
    }

    // Guard: `if (fee > amount) revert FeeExceedsAmount()`
    function test_withdraw_fee_exceeds_amount() public {
        _poolDeposit();
        vm.expectRevert(PiiPool.FeeExceedsAmount.selector);
        pool.withdraw(poolProof, POOL_ROOT, POOL_NF, RECIPIENT,
                      POOL_WITHDRAW_AMT, POOL_CHANGE_CMT, RELAYER,
                      POOL_WITHDRAW_AMT + 1,  // fee > amount
                      _poolMemos());
    }

    // Guard: `if (fee > 0 && relayer == address(0)) revert RelayerZero()`
    function test_withdraw_relayer_zero_with_fee() public {
        _poolDeposit();
        vm.expectRevert(PiiPool.RelayerZero.selector);
        pool.withdraw(poolProof, POOL_ROOT, POOL_NF, RECIPIENT,
                      POOL_WITHDRAW_AMT, POOL_CHANGE_CMT,
                      address(0),  // relayer == 0
                      POOL_FEE,    // fee > 0
                      _poolMemos());
    }

    // Guard: `if (changeCommitment != ZERO_VALUE) { _insert(...) }`
    // When change == ZERO_VALUE the contract must NOT insert a leaf
    // and must NOT emit NewCommitment for the change slot.
    function test_withdraw_zero_change_not_inserted() public {
        // Set up the full E2E state so ROOT_AFTER_XFER is known.
        _e2eDeposit3();
        _e2eTransfer();

        uint256 idxBefore = pool.nextIndex();

        vm.recordLogs();
        pool.withdraw(
            e2eWithdrawProof,
            ROOT_AFTER_XFER,
            NFB,
            RECIPIENT,
            2_500_000,
            ZERO_VALUE,   // change == sentinel → must not insert
            address(0),   // no relayer (fee=0)
            0,
            _e2eWithdrawMemos()
        );

        // nextIndex must not have advanced
        assertEq(pool.nextIndex(), idxBefore, "sentinel change must not insert a leaf");

        // No NewCommitment event should have been emitted
        Vm.Log[] memory logs = vm.getRecordedLogs();
        bytes32 newCommitmentTopic = keccak256("NewCommitment(uint256,uint256,bytes)");
        for (uint256 i = 0; i < logs.length; i++) {
            assertTrue(
                logs[i].topics[0] != newCommitmentTopic,
                "NewCommitment must not fire for ZERO_VALUE change"
            );
        }
    }

    // =========================================================================
    // TRANSFER guards
    // =========================================================================

    // Guard: `if (!isKnownRoot[a.root]) revert UnknownRoot()`
    function test_transfer_unknown_root() public {
        _e2eDeposit3();
        bytes memory fakeProof = new bytes(8000);
        PiiPool.TransferArgs memory a = PiiPool.TransferArgs({
            root:            uint256(0xDEAD),   // unknown
            nf0: NF0, nf1: NF1, nfFee: NF_FEE_XFER,
            outRecipient: OUT_RECIP, outChange: OUT_CHG,
            outFee: OUT_FEE, outFeeChange: OUT_FEE_CHG,
            eligibilityRoot: EMPTY_ROOT,
            fee: TRANSFER_FEE, relayerOwnerKey: OK_RELAYER
        });
        bytes[] memory m = new bytes[](4);
        m[0] = hex"aa01"; m[1] = hex"aa02"; m[2] = hex"aa03"; m[3] = hex"aa04";
        vm.expectRevert(PiiPool.UnknownRoot.selector);
        pool.transfer(fakeProof, a, RELAYER, m);
    }

    // ── Internal helper: discover nullifierSpent's actual storage slot by doing a
    //    real transfer (which sets nf0/nf1/nfFee spent) and then reading back the
    //    slot hash that produces `true`.  This avoids hardcoding the slot index,
    //    which shifts across inheritance changes.
    //
    //    Strategy: run the transfer, then verify nf0 is spent via the public view,
    //    then use the SAME transfer + double-spend pattern isolated per nullifier.
    //    We spin up a separate pool fork in each test so state is isolated.

    // Guard: `if (nullifierSpent[a.nf0]) revert NullifierSpent()`
    // Spend nf0 via a real transfer, then retry with a DIFFERENT nf1/nfFee pair
    // (so those checks don't fire) but the SAME nf0.
    function test_transfer_nf0_already_spent() public {
        _e2eDeposit3();
        _e2eTransfer(); // spends nf0, nf1, nfFee

        bytes memory fakeProof = new bytes(8000);
        // nf0 is spent; nf1+nfFee replaced with distinct fresh values so only nf0 triggers
        PiiPool.TransferArgs memory a = PiiPool.TransferArgs({
            root: ROOT_3,
            nf0: NF0,             // SPENT
            nf1: uint256(0xAA01), // fresh (not spent)
            nfFee: uint256(0xAA02), // fresh
            outRecipient: OUT_RECIP, outChange: OUT_CHG,
            outFee: OUT_FEE, outFeeChange: OUT_FEE_CHG,
            eligibilityRoot: EMPTY_ROOT, fee: TRANSFER_FEE, relayerOwnerKey: OK_RELAYER
        });
        bytes[] memory m = new bytes[](4);
        m[0] = hex"aa01"; m[1] = hex"aa02"; m[2] = hex"aa03"; m[3] = hex"aa04";
        vm.expectRevert(PiiPool.NullifierSpent.selector);
        pool.transfer(fakeProof, a, RELAYER, m);
    }

    // Guard: `if (nullifierSpent[a.nf1]) revert NullifierSpent()`
    function test_transfer_nf1_already_spent() public {
        _e2eDeposit3();
        _e2eTransfer(); // spends nf0, nf1, nfFee

        bytes memory fakeProof = new bytes(8000);
        PiiPool.TransferArgs memory a = PiiPool.TransferArgs({
            root: ROOT_3,
            nf0: uint256(0xBB01), // fresh
            nf1: NF1,             // SPENT
            nfFee: uint256(0xBB02), // fresh
            outRecipient: OUT_RECIP, outChange: OUT_CHG,
            outFee: OUT_FEE, outFeeChange: OUT_FEE_CHG,
            eligibilityRoot: EMPTY_ROOT, fee: TRANSFER_FEE, relayerOwnerKey: OK_RELAYER
        });
        bytes[] memory m = new bytes[](4);
        m[0] = hex"aa01"; m[1] = hex"aa02"; m[2] = hex"aa03"; m[3] = hex"aa04";
        vm.expectRevert(PiiPool.NullifierSpent.selector);
        pool.transfer(fakeProof, a, RELAYER, m);
    }

    // Guard: `if (nullifierSpent[a.nfFee]) revert NullifierSpent()`
    function test_transfer_nfFee_already_spent() public {
        _e2eDeposit3();
        _e2eTransfer(); // spends nf0, nf1, nfFee

        bytes memory fakeProof = new bytes(8000);
        PiiPool.TransferArgs memory a = PiiPool.TransferArgs({
            root: ROOT_3,
            nf0: uint256(0xCC01), // fresh
            nf1: uint256(0xCC02), // fresh
            nfFee: NF_FEE_XFER,   // SPENT
            outRecipient: OUT_RECIP, outChange: OUT_CHG,
            outFee: OUT_FEE, outFeeChange: OUT_FEE_CHG,
            eligibilityRoot: EMPTY_ROOT, fee: TRANSFER_FEE, relayerOwnerKey: OK_RELAYER
        });
        bytes[] memory m = new bytes[](4);
        m[0] = hex"aa01"; m[1] = hex"aa02"; m[2] = hex"aa03"; m[3] = hex"aa04";
        vm.expectRevert(PiiPool.NullifierSpent.selector);
        pool.transfer(fakeProof, a, RELAYER, m);
    }

    // Guard: `if (a.nf0 == a.nf1 || ...) revert DuplicateNullifier()`
    // Only nf0 == nf1 tested (the guard covers all three pairs in one condition).
    function test_transfer_duplicate_nullifier_nf0_eq_nf1() public {
        _e2eDeposit3();
        bytes memory fakeProof = new bytes(8000);
        PiiPool.TransferArgs memory a = PiiPool.TransferArgs({
            root: ROOT_3, nf0: NF0, nf1: NF0,  // same as nf0 — duplicate
            nfFee: NF_FEE_XFER,
            outRecipient: OUT_RECIP, outChange: OUT_CHG,
            outFee: OUT_FEE, outFeeChange: OUT_FEE_CHG,
            eligibilityRoot: EMPTY_ROOT, fee: TRANSFER_FEE, relayerOwnerKey: OK_RELAYER
        });
        bytes[] memory m = new bytes[](4);
        m[0] = hex"aa01"; m[1] = hex"aa02"; m[2] = hex"aa03"; m[3] = hex"aa04";
        vm.expectRevert(PiiPool.DuplicateNullifier.selector);
        pool.transfer(fakeProof, a, RELAYER, m);
    }

    // Guard: `if (memos.length != 4) revert WrongMemoCount()`
    function test_transfer_wrong_memo_count() public {
        _e2eDeposit3();
        bytes memory fakeProof = new bytes(8000);
        PiiPool.TransferArgs memory a = PiiPool.TransferArgs({
            root: ROOT_3, nf0: NF0, nf1: NF1, nfFee: NF_FEE_XFER,
            outRecipient: OUT_RECIP, outChange: OUT_CHG,
            outFee: OUT_FEE, outFeeChange: OUT_FEE_CHG,
            eligibilityRoot: EMPTY_ROOT, fee: TRANSFER_FEE, relayerOwnerKey: OK_RELAYER
        });
        bytes[] memory m = new bytes[](3);  // WRONG: must be exactly 4
        m[0] = hex"aa01"; m[1] = hex"aa02"; m[2] = hex"aa03";
        vm.expectRevert(PiiPool.WrongMemoCount.selector);
        pool.transfer(fakeProof, a, RELAYER, m);
    }

    // =========================================================================
    // HARNESS: _insertOutput sentinel skip
    // =========================================================================

    // Guard: `if (commitment != ZERO_VALUE) { _insert(...) }`
    // _insertOutput(ZERO_VALUE, ...) must not insert and must not emit NewCommitment.
    function test_insert_output_skips_zero_value() public {
        uint256 idxBefore = harness.nextIdx();

        vm.recordLogs();
        harness.insertOutputPub(ZERO_VALUE, hex"");

        assertEq(harness.nextIdx(), idxBefore, "ZERO_VALUE must not advance nextIndex");

        Vm.Log[] memory logs = vm.getRecordedLogs();
        bytes32 topic = keccak256("NewCommitment(uint256,uint256,bytes)");
        for (uint256 i = 0; i < logs.length; i++) {
            assertTrue(logs[i].topics[0] != topic, "NewCommitment must not fire for ZERO_VALUE");
        }
    }

    // Guard: `if (commitment != ZERO_VALUE) { _insert(...) }` — positive side
    // A normal commitment IS inserted and DOES emit NewCommitment.
    function test_insert_output_normal_commitment() public {
        uint256 normalCmt = LibPiiHash.hash2(12345, 678);  // arbitrary non-sentinel

        uint256 idxBefore = harness.nextIdx();

        vm.recordLogs();
        harness.insertOutputPub(normalCmt, hex"dead");

        assertEq(harness.nextIdx(), idxBefore + 1, "normal commitment must advance nextIndex");

        Vm.Log[] memory logs = vm.getRecordedLogs();
        bytes32 topic = keccak256("NewCommitment(uint256,uint256,bytes)");
        bool found;
        for (uint256 i = 0; i < logs.length; i++) {
            if (logs[i].topics[0] == topic) { found = true; break; }
        }
        assertTrue(found, "NewCommitment must fire for a normal commitment");
    }
}
