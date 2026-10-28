// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Ownable2Step, Ownable} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {ReentrancyGuard}        from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {SafeERC20, IERC20}      from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {PiiMerkle}              from "./PiiMerkle.sol";
import {LibPiiHash}             from "./LibPiiHash.sol";

/// @dev Minimal IVerifier — identical to the interface in every HonkVerifier.
interface IVerifier {
    function verify(bytes calldata _proof, bytes32[] calldata _publicInputs)
        external view returns (bool);
}

/**
 * @title  PiiPool
 * @notice Shielded USDC pool for the Pii private marketplace (SPEC §5, v1).
 *
 * Supports:
 *   - deposit:   pull USDC, derive commitment on-chain, insert leaf.
 *   - withdraw:  ZK-proven deduction of a note, pay recipient publicly.
 *   - transfer:  ZK-proven shielded note → note swap; no ERC-20 movement.
 *
 * Security properties:
 *   - Commitment binding: the contract computes hash3(USDC_ID, amount, secret)
 *     on-chain.  The caller never supplies a commitment.
 *   - Double-spend: nullifiers are marked BEFORE external calls (CEI order).
 *   - ext_data_hash: recomputed on-chain, checked against the circuit public input.
 *   - Deposits may be paused; withdrawals and transfers are NEVER pausable.
 *   - ReentrancyGuard on every state-mutating entry point.
 */
contract PiiPool is PiiMerkle, Ownable2Step, ReentrancyGuard {
    using SafeERC20 for IERC20;

    // ── Constants ────────────────────────────────────────────────────────────

    /// @dev Fixed memo length: ephPub(33) + nonce(12) + ct+tag(89) = 134 bytes.
    uint256 internal constant MEMO_LENGTH = 134;

    // ── Immutables ───────────────────────────────────────────────────────────

    IERC20    public immutable usdc;
    uint256   public immutable USDC_ID;           // hash2(uint160(usdc), 0)
    IVerifier public immutable withdrawVerifier;
    IVerifier public immutable transferVerifier;
    uint256   public immutable EMPTY_TREE_ROOT;  // cached for v1 eligibility check

    // ── Mutable config ────────────────────────────────────────────────────────

    uint256 public maxDeposit;
    uint256 public maxPoolBalance;
    bool    public depositsPaused;

    // ── Nullifier registry ────────────────────────────────────────────────────

    mapping(uint256 => bool) public nullifierSpent;

    // ── Events ────────────────────────────────────────────────────────────────

    /// @notice Emitted for EVERY shielded commitment inserted into the tree
    ///         (deposit, withdraw change, all 4 transfer outputs).  The SDK
    ///         syncs the tree and recovers wallet state by listening to this
    ///         single event type.  Every memo is exactly MEMO_LENGTH bytes.
    event NewCommitment(
        uint256 indexed leafIndex,
        uint256 commitment,
        bytes   memo           // always MEMO_LENGTH bytes; encrypted ECIES memo
    );

    event Deposited(
        uint256 indexed leafIndex,
        uint256 commitment,
        uint256 amount,
        uint256 newRoot
    );

    event Withdrawn(
        uint256 indexed nullifier,
        address indexed recipient,
        uint256 amount,
        uint256 fee,
        uint256 changeLeafIndex,
        bytes[] memos
    );

    event Transferred(
        uint256 indexed nf0,
        uint256 indexed nf1,
        uint256         nfFee
    );

    // ── Custom errors ─────────────────────────────────────────────────────────

    error DepositsPaused();
    error AmountZero();
    error AmountTooLarge();
    error ExceedsMaxDeposit();
    error ExceedsMaxPoolBalance();
    error SecretOutOfField();
    error NullifierSpent();
    error UnknownRoot();
    error RecipientZero();
    error FeeExceedsAmount();
    error RelayerZero();
    error DuplicateNullifier();
    error WrongMemoCount();
    error BadMemo();
    error EligibilityRootMismatch();
    error ProofInvalid();

    // ── Transfer args struct ──────────────────────────────────────────────────

    struct TransferArgs {
        uint256 root;
        uint256 nf0;
        uint256 nf1;
        uint256 nfFee;
        uint256 outRecipient;
        uint256 outChange;
        uint256 outFee;
        uint256 outFeeChange;
        uint256 eligibilityRoot;
        uint256 fee;
        uint256 relayerOwnerKey;
    }

    // ── Constructor ───────────────────────────────────────────────────────────

    constructor(
        address usdc_,
        address withdrawVerifier_,
        address transferVerifier_,
        address initialOwner_,
        uint256 maxDeposit_,
        uint256 maxPoolBalance_
    )
        PiiMerkle()
        Ownable(initialOwner_)
    {
        usdc             = IERC20(usdc_);
        withdrawVerifier = IVerifier(withdrawVerifier_);
        transferVerifier = IVerifier(transferVerifier_);
        maxDeposit       = maxDeposit_;
        maxPoolBalance   = maxPoolBalance_;
        USDC_ID          = LibPiiHash.hash2(uint160(usdc_), 0);
        EMPTY_TREE_ROOT  = currentRoot;  // set by PiiMerkle() before this line runs
    }

    // ── Deposit ───────────────────────────────────────────────────────────────

    /**
     * @notice Deposit USDC into the shielded pool.
     * @param amount  Non-zero, < 2^64, <= maxDeposit.
     * @param secret  hash2(owner_key, blinding) — must be < BN254_R.
     *                Commitment is derived on-chain; the caller cannot lie
     *                about asset or amount.
     * @param memo    ECIES-encrypted note memo, exactly 134 bytes.
     *                The depositor should encrypt to their own enc_pub so the
     *                wallet can be recovered from on-chain events alone.
     */
    function deposit(uint256 amount, uint256 secret, bytes calldata memo) external nonReentrant {
        if (depositsPaused)                                  revert DepositsPaused();
        if (amount == 0)                                     revert AmountZero();
        if (amount >= (1 << 64))                             revert AmountTooLarge();
        if (amount > maxDeposit)                             revert ExceedsMaxDeposit();
        if (secret >= BN254_R)                               revert SecretOutOfField();
        if (memo.length != MEMO_LENGTH)                      revert BadMemo();
        if (usdc.balanceOf(address(this)) + amount > maxPoolBalance)
                                                             revert ExceedsMaxPoolBalance();

        usdc.safeTransferFrom(msg.sender, address(this), amount);

        uint256 cmt = LibPiiHash.noteCommitment(USDC_ID, amount, secret);
        (uint256 leafIndex, uint256 newRoot) = _insert(cmt);

        emit NewCommitment(leafIndex, cmt, memo);
        emit Deposited(leafIndex, cmt, amount, newRoot);
    }

    // ── Withdraw ──────────────────────────────────────────────────────────────

    /**
     * @notice Withdraw USDC using a ZK proof.
     *
     * Public inputs (SPEC §4.1):
     *   [0] merkle_root  [1] nullifier  [2] recipient  [3] amount
     *   [4] change_commitment  [5] ext_data_hash
     *
     * ext_data_hash = keccak(memos, relayer, fee, recipient, chainid, pool) % r
     */
    function withdraw(
        bytes   calldata proof,
        uint256 root,
        uint256 nullifier,
        address recipient,
        uint256 amount,
        uint256 changeCommitment,
        address relayer,
        uint256 fee,
        bytes[] calldata memos
    ) external nonReentrant {
        if (!isKnownRoot[root])                              revert UnknownRoot();
        if (nullifierSpent[nullifier])                       revert NullifierSpent();
        if (recipient == address(0))                         revert RecipientZero();
        if (fee > amount)                                    revert FeeExceedsAmount();
        if (fee > 0 && relayer == address(0))                revert RelayerZero();

        uint256 extDataHash = uint256(keccak256(
            abi.encode(memos, relayer, fee, recipient, block.chainid, address(this))
        )) % BN254_R;

        bytes32[] memory publicInputs = new bytes32[](6);
        publicInputs[0] = bytes32(root);
        publicInputs[1] = bytes32(nullifier);
        publicInputs[2] = bytes32(uint256(uint160(recipient)));
        publicInputs[3] = bytes32(amount);
        publicInputs[4] = bytes32(changeCommitment);
        publicInputs[5] = bytes32(extDataHash);

        _verifyProof(withdrawVerifier, proof, publicInputs);

        // CEI: mark spent BEFORE transfers
        nullifierSpent[nullifier] = true;

        uint256 changeLeafIndex = type(uint256).max;
        if (changeCommitment != ZERO_VALUE) {
            bytes memory changeMemo = memos.length > 0 ? memos[0] : bytes("");
            (changeLeafIndex,) = _insert(changeCommitment);
            emit NewCommitment(changeLeafIndex, changeCommitment, changeMemo);
        }

        uint256 net = amount - fee;
        if (net > 0) usdc.safeTransfer(recipient, net);
        if (fee > 0) usdc.safeTransfer(relayer, fee);

        emit Withdrawn(nullifier, recipient, amount, fee, changeLeafIndex, memos);
    }

    // ── Transfer ──────────────────────────────────────────────────────────────

    /**
     * @notice Shielded note-to-note transfer.  No ERC-20 movement; the relayer
     *         is compensated by the fee output note.
     *
     * Public inputs (SPEC §4.2):
     *   [0]  root            [1]  nf0           [2]  nf1
     *   [3]  nfFee           [4]  outRecipient  [5]  outChange
     *   [6]  outFee          [7]  outFeeChange  [8]  eligibilityRoot
     *   [9]  fee             [10] relayerOwnerKey [11] ext_data_hash
     *
     * ext_data_hash = keccak(memos, relayer, fee, address(0), chainid, pool) % r
     *   (recipient is address(0) because the recipient is a shielded owner_key,
     *    not a public address.)
     *
     * v1: eligibilityRoot must equal emptyRoot().
     * TODO v2: replace with registry's KYC/allowlist root window.
     */
    function transfer(
        bytes          calldata proof,
        TransferArgs   calldata a,
        address                 relayer,
        bytes[]        calldata memos
    ) external nonReentrant {
        // ── Validation ────────────────────────────────────────────────────────
        if (!isKnownRoot[a.root])                            revert UnknownRoot();
        if (nullifierSpent[a.nf0])                           revert NullifierSpent();
        if (nullifierSpent[a.nf1])                           revert NullifierSpent();
        if (nullifierSpent[a.nfFee])                         revert NullifierSpent();
        if (a.nf0 == a.nf1 || a.nf0 == a.nfFee || a.nf1 == a.nfFee)
                                                             revert DuplicateNullifier();
        if (memos.length != 4)                               revert WrongMemoCount();
        // v1: no on-chain KYC/allowlist root — eligibilityRoot must be empty.
        if (a.eligibilityRoot != EMPTY_TREE_ROOT)            revert EligibilityRootMismatch();

        // ── ext_data_hash ─────────────────────────────────────────────────────
        // recipient is address(0): the true recipient is a shielded owner_key.
        uint256 extDataHash = uint256(keccak256(
            abi.encode(memos, relayer, a.fee, address(0), block.chainid, address(this))
        )) % BN254_R;

        // ── Build public inputs (circuit order) ───────────────────────────────
        bytes32[] memory publicInputs = new bytes32[](12);
        publicInputs[0]  = bytes32(a.root);
        publicInputs[1]  = bytes32(a.nf0);
        publicInputs[2]  = bytes32(a.nf1);
        publicInputs[3]  = bytes32(a.nfFee);
        publicInputs[4]  = bytes32(a.outRecipient);
        publicInputs[5]  = bytes32(a.outChange);
        publicInputs[6]  = bytes32(a.outFee);
        publicInputs[7]  = bytes32(a.outFeeChange);
        publicInputs[8]  = bytes32(a.eligibilityRoot);
        publicInputs[9]  = bytes32(a.fee);
        publicInputs[10] = bytes32(a.relayerOwnerKey);
        publicInputs[11] = bytes32(extDataHash);

        _verifyProof(transferVerifier, proof, publicInputs);

        // ── CEI: mark nullifiers spent BEFORE any state changes ───────────────
        nullifierSpent[a.nf0]   = true;
        nullifierSpent[a.nf1]   = true;
        nullifierSpent[a.nfFee] = true;

        // ── Insert non-sentinel output commitments ────────────────────────────
        _insertOutput(a.outRecipient, memos[0]);
        _insertOutput(a.outChange,    memos[1]);
        _insertOutput(a.outFee,       memos[2]);
        _insertOutput(a.outFeeChange, memos[3]);

        emit Transferred(a.nf0, a.nf1, a.nfFee);
    }

    // ── Internal helpers ──────────────────────────────────────────────────────

    function _verifyProof(
        IVerifier verifier,
        bytes calldata proof,
        bytes32[] memory publicInputs
    ) internal view {
        bool ok;
        try verifier.verify(proof, publicInputs) returns (bool result) {
            ok = result;
        } catch {
            revert ProofInvalid();
        }
        if (!ok) revert ProofInvalid();
    }

    function _insertOutput(uint256 commitment, bytes calldata memo) internal {
        if (commitment != ZERO_VALUE) {
            (uint256 idx,) = _insert(commitment);
            emit NewCommitment(idx, commitment, memo);
        }
    }

    // ── Owner-only configuration ──────────────────────────────────────────────

    /// @notice Update pool deposit and balance caps.
    function setCaps(uint256 maxDeposit_, uint256 maxPoolBalance_) external onlyOwner {
        maxDeposit    = maxDeposit_;
        maxPoolBalance = maxPoolBalance_;
    }

    /// @notice Pause or unpause new deposits.  Withdrawals and transfers are never paused.
    function setDepositsPaused(bool paused) external onlyOwner {
        depositsPaused = paused;
    }
}
