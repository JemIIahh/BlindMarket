// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {IERC1271} from "@openzeppelin/contracts/interfaces/IERC1271.sol";

/// The BlindEscrow worker calls a sponsored agent wallet may make.
interface IBlindEscrowWorker {
    function submitEvidence(uint256 taskId, bytes32 evidenceHash) external;
    function releaseUnjudgedWork(uint256 taskId) external;
    function submitOpen(uint256 taskId, bytes32 evidenceHash) external;
}

/**
 * @title BlindAgentDelegate
 * @author BlindMarket Team
 * @notice EIP-7702 delegate for hosted agent wallets, so BlindMarket can pay
 *         an agent's escrow gas without sending the agent money. The agent's
 *         EOA delegates to this code and the relayer calls execute() on the
 *         agent's own address, paying the gas. The code runs as the EOA, so
 *         BlindEscrow sees msg.sender == agent and onlyWorker passes.
 *
 * @dev Every call carries an EIP-712 signature by the wallet's own key, in a
 *      domain bound to the wallet (verifyingContract = address(this), the EOA
 *      when delegated) and the chain. The signed Call also names ESCROW, so a
 *      signature never carries over to a delegate bound to another escrow.
 *      OZ EIP712 rebuilds its domain separator whenever address(this) differs
 *      from the deploying contract, which is always the case when delegated.
 *
 *      Only submitEvidence, releaseUnjudgedWork and (from version 2)
 *      submitOpen on ESCROW, never with value. No owner, no upgrade path. A 7702 wallet's storage is the EOA's
 *      and outlives any one delegate, so the only state is the nonce in an
 *      ERC-7201 namespace. The EIP712 name and version stay under 32 bytes so
 *      OZ's ShortStrings never falls back to its (un-namespaced) storage.
 *      Calling the deployed contract directly is inert: no key signs for it.
 *
 *      Versions. DELEGATE_VERSION names the kinds a delegate relays. Version
 *      1, the delegates deployed on Arc testnet and Arc mainnet as of
 *      2026-10, has no DELEGATE_VERSION function: a call to it reverts, which
 *      callers read as version 1 (SubmitEvidence and ReleaseUnjudgedWork).
 *      Version 2 adds SubmitOpen. The EIP-712 name and version stay
 *      "BlindAgentDelegate" / "1", so a signed call of kind 0 or 1 means the
 *      same under either version and its nonce is spent once across both; a
 *      version-1 delegate rejects kind 2 when it decodes the call, before
 *      any code runs.
 */
contract BlindAgentDelegate is EIP712, IERC1271 {
    // ── Types ──

    enum Kind {
        SubmitEvidence,      // 0 — ESCROW.submitEvidence(taskId, evidenceHash)
        ReleaseUnjudgedWork, // 1 — ESCROW.releaseUnjudgedWork(taskId); evidenceHash must be 0
        SubmitOpen           // 2 — ESCROW.submitOpen(taskId, evidenceHash); version 2 on
    }

    struct Call {
        Kind kind;
        uint256 taskId;
        bytes32 evidenceHash;
        uint256 nonce;     // must equal nonce()
        uint256 deadline;  // unix seconds; valid while block.timestamp <= deadline
    }

    /// @custom:storage-location erc7201:blindmarket.storage.AgentDelegate
    struct AgentDelegateStorage {
        uint256 nonce;
    }

    // ── Constants ──

    /// The signed struct: a Call plus the escrow this delegate is bound to.
    bytes32 public constant CALL_TYPEHASH = keccak256(
        "Call(uint8 kind,address escrow,uint256 taskId,bytes32 evidenceHash,uint256 nonce,uint256 deadline)"
    );

    // keccak256(abi.encode(uint256(keccak256("blindmarket.storage.AgentDelegate")) - 1)) & ~bytes32(uint256(0xff))
    bytes32 private constant STORAGE_LOCATION = 0x2cb27ebb7a362eb42f6c76e9e3e85fc880d054822147695d5abee89e7aef5f00;

    bytes4 private constant ERC1271_INVALID = 0xffffffff;

    /// The kinds this delegate relays: 2 = SubmitEvidence, ReleaseUnjudgedWork
    /// and SubmitOpen. Version 1 has no such function (see the contract notes).
    uint256 public constant DELEGATE_VERSION = 2;

    // ── State ──

    /// The only contract this delegate calls. Immutable: in the bytecode,
    /// so the same in every delegated wallet.
    address public immutable ESCROW;

    // ── Events ──

    event SponsoredCall(Kind kind, uint256 taskId, uint256 nonce);

    // ── Errors ──

    error ZeroAddress();
    error Expired();
    error InvalidNonce(uint256 current);
    error InvalidSignature();
    error UnexpectedEvidenceHash();

    // ── Constructor ──

    constructor(address escrow) EIP712("BlindAgentDelegate", "1") {
        if (escrow == address(0)) revert ZeroAddress();
        ESCROW = escrow;
    }

    // ── Core Functions ──

    /**
     * @notice Make one signed escrow call as this wallet. Anyone may send it
     *         (the relayer, normally); the signature is the authorization.
     * @dev Non-payable: no value ever reaches the escrow. The nonce moves
     *      before the external call, and an escrow revert is re-thrown with
     *      its original data, undoing the nonce.
     */
    function execute(Call calldata c, bytes calldata signature) external {
        if (block.timestamp > c.deadline) revert Expired();
        if (c.kind == Kind.ReleaseUnjudgedWork && c.evidenceHash != bytes32(0)) revert UnexpectedEvidenceHash();

        AgentDelegateStorage storage $ = _storage();
        uint256 current = $.nonce;
        if (c.nonce != current) revert InvalidNonce(current);

        bytes32 structHash = keccak256(
            abi.encode(CALL_TYPEHASH, c.kind, ESCROW, c.taskId, c.evidenceHash, c.nonce, c.deadline)
        );
        if (!_signedByWallet(_hashTypedDataV4(structHash), signature)) revert InvalidSignature();

        // ── Effects ──
        $.nonce = current + 1;

        // ── Interactions ──
        bytes memory data;
        if (c.kind == Kind.SubmitEvidence) {
            data = abi.encodeCall(IBlindEscrowWorker.submitEvidence, (c.taskId, c.evidenceHash));
        } else if (c.kind == Kind.SubmitOpen) {
            data = abi.encodeCall(IBlindEscrowWorker.submitOpen, (c.taskId, c.evidenceHash));
        } else {
            data = abi.encodeCall(IBlindEscrowWorker.releaseUnjudgedWork, (c.taskId));
        }
        (bool ok, bytes memory ret) = ESCROW.call(data);
        if (!ok) {
            assembly ("memory-safe") {
                revert(add(ret, 0x20), mload(ret))
            }
        }

        emit SponsoredCall(c.kind, c.taskId, current);
    }

    /// The nonce the next execute() must carry.
    function nonce() external view returns (uint256) {
        return _storage().nonce;
    }

    /**
     * @notice ERC-1271: valid when the wallet's own key signed `hash`, as an
     *         EOA's signature would be checked. Never reverts on a bad
     *         signature.
     */
    function isValidSignature(bytes32 hash, bytes calldata signature) external view returns (bytes4) {
        return _signedByWallet(hash, signature) ? IERC1271.isValidSignature.selector : ERC1271_INVALID;
    }

    /// Native top-ups still reach the wallet. There is deliberately no fallback.
    receive() external payable {}

    // ── Internal ──

    function _signedByWallet(bytes32 digest, bytes calldata signature) private view returns (bool) {
        (address signer, ECDSA.RecoverError err, ) = ECDSA.tryRecoverCalldata(digest, signature);
        return err == ECDSA.RecoverError.NoError && signer == address(this);
    }

    function _storage() private pure returns (AgentDelegateStorage storage $) {
        assembly ("memory-safe") {
            $.slot := STORAGE_LOCATION
        }
    }
}
