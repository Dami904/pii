// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/**
 * @title PiiKeyRegistry
 * @notice Stores per-user secp256k1 viewing-key public keys.
 *
 * Any address may register or rotate its own key.  The registry does
 * not validate key ownership — it is the user's responsibility to
 * register the correct enc_pub that corresponds to their Pii viewing key.
 *
 * Key format: compressed secp256k1 public key, exactly 33 bytes,
 * first byte 0x02 or 0x03.
 */
contract PiiKeyRegistry {
    // ── Storage ───────────────────────────────────────────────────────────────

    struct Key {
        bytes encPub; // 33-byte compressed secp256k1 public key
    }

    mapping(address => Key) private _keys;

    // ── Events ────────────────────────────────────────────────────────────────

    event KeyRegistered(address indexed owner, bytes encPub);

    // ── Errors ────────────────────────────────────────────────────────────────

    error InvalidKeyLength();   // encPub.length != 33
    error InvalidKeyPrefix();   // first byte is not 0x02 or 0x03

    // ── External ──────────────────────────────────────────────────────────────

    /**
     * @notice Register or rotate the caller's viewing-key public key.
     * @param encPub 33-byte compressed secp256k1 public key.
     *               Re-registration overwrites the previous key (key rotation).
     */
    function register(bytes calldata encPub) external {
        if (encPub.length != 33) revert InvalidKeyLength();
        uint8 prefix = uint8(encPub[0]);
        if (prefix != 0x02 && prefix != 0x03) revert InvalidKeyPrefix();

        _keys[msg.sender].encPub = encPub;
        emit KeyRegistered(msg.sender, encPub);
    }

    /**
     * @notice Returns the registered enc_pub for an address, or empty bytes
     *         if no key has been registered.
     */
    function getKey(address owner) external view returns (bytes memory) {
        return _keys[owner].encPub;
    }
}
