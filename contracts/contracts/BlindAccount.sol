// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Account} from "@openzeppelin/contracts/account/Account.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {PackedUserOperation, IEntryPoint} from "@openzeppelin/contracts/interfaces/draft-IERC4337.sol";
import {ERC4337Utils} from "@openzeppelin/contracts/account/utils/draft-ERC4337Utils.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/**
 * @title BlindAccount
 * @notice Minimal ERC-4337 smart account for BlindMarket agents.
 *         Owned by a single ECDSA key (the agent's private key).
 *         Supports execute() and executeBatch() for arbitrary calls.
 */
contract BlindAccount is Account {
    using ERC4337Utils for PackedUserOperation;

    address private _owner;
    bool private _initialized;

    modifier onlyEntryPointOrOwner() {
        require(
            msg.sender == _owner || msg.sender == address(entryPoint()),
            "BlindAccount: not owner nor entrypoint"
        );
        _;
    }

    constructor(address owner_, address usdc, address paymaster) {
        if (owner_ == address(0)) return; // implementation stub — never called
        _owner = owner_;
        _initialized = true;
        if (usdc != address(0) && paymaster != address(0)) {
            IERC20(usdc).approve(paymaster, type(uint256).max);
        }
    }

    function entryPoint() public view override returns (IEntryPoint) {
        return ERC4337Utils.ENTRYPOINT_V07;
    }

    function owner() public view returns (address) {
        return _owner;
    }

    function _rawSignatureValidation(
        bytes32 hash,
        bytes calldata signature
    ) internal view override returns (bool) {
        return ECDSA.recover(hash, signature) == _owner;
    }

    // NOTE: the caller here is the EntryPoint in the real ERC-4337 flow
    // (it invokes sender.execute(...) after signature validation), NOT the
    // owner EOA — so this must accept the EntryPoint too. A strict onlyOwner
    // passed all unit tests (they call execute as the owner directly) yet
    // reverted every real UserOp on-chain with "not owner".
    function execute(address to, uint256 value, bytes calldata data) external onlyEntryPointOrOwner {
        _call(to, value, data);
    }

    function executeBatch(address[] calldata to, uint256[] calldata value, bytes[] calldata data) external onlyEntryPointOrOwner {
        require(to.length == value.length && value.length == data.length, "BlindAccount: length mismatch");
        for (uint256 i = 0; i < to.length; i++) {
            _call(to[i], value[i], data[i]);
        }
    }

    function _call(address to, uint256 value, bytes calldata data) private {
        (bool ok, ) = to.call{value: value}(data);
        if (!ok) {
            assembly { revert(0, 0) }
        }
    }

    receive() external payable override {}
}
