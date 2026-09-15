// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {PackedUserOperation, IEntryPoint, IAccount} from "@openzeppelin/contracts/interfaces/draft-IERC4337.sol";

/**
 * @title MockEntryPoint
 * @notice Minimal EntryPoint mock for testing. Handles deposit accounting
 *         and UserOp execution via a simulated validation loop.
 */
contract MockEntryPoint is IEntryPoint {
    mapping(address => uint256) private _balances;

    function balanceOf(address account) external view override returns (uint256) {
        return _balances[account];
    }

    function depositTo(address account) external payable override {
        _balances[account] += msg.value;
    }

    /** Alias for depositTo — funds a paymaster or other entity at this EP. */
    function depositFor(address account) external payable {
        _balances[account] += msg.value;
    }

    function withdrawTo(address payable withdrawAddress, uint256 withdrawAmount) external override {
        require(_balances[msg.sender] >= withdrawAmount, "Insufficient balance");
        _balances[msg.sender] -= withdrawAmount;
        withdrawAddress.transfer(withdrawAmount);
    }

    function addStake(uint32) external payable override {}
    function unlockStake() external override {}
    function withdrawStake(address payable) external override {}

    function getNonce(address, uint192) external pure override returns (uint256) {
        return 0;
    }

    function handleOps(PackedUserOperation[] calldata ops, address payable) external override {
        for (uint256 i = 0; i < ops.length; i++) {
            _handleOp(ops[i]);
        }
    }

    function handleAggregatedOps(
        UserOpsPerAggregator[] calldata opsPerAggregator,
        address payable
    ) external override {
        for (uint256 i = 0; i < opsPerAggregator.length; i++) {
            for (uint256 j = 0; j < opsPerAggregator[i].userOps.length; j++) {
                _handleOp(opsPerAggregator[i].userOps[j]);
            }
        }
    }

    function _handleOp(PackedUserOperation calldata op) internal {
        IAccount(op.sender).validateUserOp(op, keccak256("test-op-hash"), 0);
        (bool ok, ) = op.sender.call(op.callData);
        require(ok, "MockEntryPoint: op execution failed");
    }

    receive() external payable {}
}
