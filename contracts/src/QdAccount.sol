// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {QdRaccoonVerifier} from "./QdRaccoonVerifier.sol";

/// @title Shared QD-Wallet smart account
/// @notice Holds funds for one QD account key pk_j (one derivation index of a
/// shared wallet's Threshold Raccoon key). It executes exactly the call that
/// a valid Raccoon signature authorises; there is no owner, no ECDSA key and
/// no upgrade path. Anyone may submit an authorised call (and pay its gas).
///
/// The signed 32-byte message is
///   keccak256(abi.encode(EXECUTE_TYPEHASH, chainid, this, nonce, to, value,
///             keccak256(data), callGasLimit, validUntil, proposalDigest))
/// which binds the chain, this account, a single-use nonce, the call, the gas
/// given to it, an expiry and the approved proposal's digest.
contract QdAccount {
    bytes32 public constant EXECUTE_TYPEHASH = keccak256(
        "QDWallet.Execute(uint256 chainId,address account,uint256 nonce,address to,uint256 value,bytes32 dataHash,uint256 callGasLimit,uint256 validUntil,bytes32 proposalDigest)"
    );

    QdRaccoonVerifier public immutable verifier;
    /// keccak256("QD-VK-v1" ‖ pk_j)
    bytes32 public immutable publicKeyHash;
    uint256 public nonce;

    /// Emitted once per consumed nonce. `success` is the inner call's result:
    /// the nonce is consumed even if the call reverts, so a signature can
    /// never be replayed later under different chain state.
    event Executed(uint256 indexed nonce, bytes32 indexed message, bytes32 indexed proposalDigest, address to, uint256 value, bool success);
    event Received(address indexed from, uint256 value);

    error Expired();
    error BadNonce();
    error WrongPublicKey();
    error InvalidSignature();
    error InsufficientGas();

    constructor(QdRaccoonVerifier verifier_, bytes32 publicKeyHash_) {
        verifier = verifier_;
        publicKeyHash = publicKeyHash_;
    }

    receive() external payable {
        emit Received(msg.sender, msg.value);
    }

    /// One authorised call. `nonce` must equal the account's current nonce.
    struct Call {
        uint256 nonce;
        address to;
        uint256 value;
        bytes data;
        uint256 callGasLimit;
        uint256 validUntil;
        bytes32 proposalDigest;
    }

    function executionMessage(Call calldata c) public view returns (bytes32) {
        return keccak256(
            abi.encode(
                EXECUTE_TYPEHASH,
                block.chainid,
                address(this),
                c.nonce,
                c.to,
                c.value,
                keccak256(c.data),
                c.callGasLimit,
                c.validUntil,
                c.proposalDigest
            )
        );
    }

    /// @notice Executes `c.to.call{value: c.value, gas: c.callGasLimit}(c.data)` if
    /// `signature` is a valid Raccoon signature under this account's key on
    /// `executionMessage(c)`.
    function execute(Call calldata c, bytes calldata publicKey, bytes calldata signature) external returns (bool success) {
        if (block.timestamp > c.validUntil) revert Expired();
        if (c.nonce != nonce) revert BadNonce();
        if (verifier.publicKeyHash(publicKey) != publicKeyHash) revert WrongPublicKey();
        bytes32 message = executionMessage(c);
        if (!verifier.verify(publicKey, message, signature)) revert InvalidSignature();

        nonce = c.nonce + 1;
        // The relayer chooses the outer gas; make sure the inner call really
        // gets callGasLimit (EIP-150 forwards at most 63/64 of what remains).
        if (gasleft() < (c.callGasLimit * 64) / 63 + 10_000) revert InsufficientGas();
        (success,) = c.to.call{value: c.value, gas: c.callGasLimit}(c.data);
        emit Executed(c.nonce, message, c.proposalDigest, c.to, c.value, success);
    }
}

/// @title Deterministic factory for QdAccount
/// @notice account = CREATE2(this, salt = publicKeyHash, QdAccount(verifier, publicKeyHash)).
/// The address depends only on the factory, the verifier and pk_j, so it can
/// be funded before deployment, and it is the same on every chain where the
/// factory lives at the same address.
contract QdAccountFactory {
    QdRaccoonVerifier public immutable verifier;

    event AccountCreated(address indexed account, bytes32 indexed publicKeyHash);

    constructor(QdRaccoonVerifier verifier_) {
        verifier = verifier_;
    }

    function accountAddress(bytes32 publicKeyHash) public view returns (address) {
        bytes32 codeHash = keccak256(abi.encodePacked(type(QdAccount).creationCode, abi.encode(verifier, publicKeyHash)));
        return address(uint160(uint256(keccak256(abi.encodePacked(bytes1(0xff), address(this), publicKeyHash, codeHash)))));
    }

    /// Idempotent: returns the existing account if already deployed.
    function createAccount(bytes32 publicKeyHash) external returns (address account) {
        account = accountAddress(publicKeyHash);
        if (account.code.length > 0) return account;
        QdAccount deployed = new QdAccount{salt: publicKeyHash}(verifier, publicKeyHash);
        account = address(deployed);
        emit AccountCreated(account, publicKeyHash);
    }
}
