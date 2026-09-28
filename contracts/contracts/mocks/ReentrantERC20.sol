// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "./MockERC20.sol";

interface IBlindEscrowBatch {
    struct TaskInput {
        bytes32 taskHash;
        uint256 amount;
        string category;
        string locationZone;
        uint256 duration;
        address verifierAgent;
    }

    function createTasks(address token, TaskInput[] calldata tasks) external payable returns (uint256);
}

/**
 * Test-only: an ERC-20 that, once armed, calls back into the escrow's
 * createTasks from inside transferFrom — the reentrancy BlindEscrow's
 * nonReentrant guard must stop. The inner revert is not caught, so it
 * propagates out of the outer call.
 */
contract ReentrantERC20 is MockERC20 {
    address public target;
    bool public armed;

    constructor() MockERC20("Reentrant Token", "RENT", 6) {}

    function arm(address target_) external {
        target = target_;
        armed = true;
    }

    function transferFrom(address from, address to, uint256 value) public override returns (bool) {
        if (armed) {
            armed = false;
            IBlindEscrowBatch.TaskInput[] memory tasks = new IBlindEscrowBatch.TaskInput[](1);
            tasks[0] = IBlindEscrowBatch.TaskInput({
                taskHash: keccak256("reentered"),
                amount: 1,
                category: "general",
                locationZone: "global",
                duration: 1 days,
                verifierAgent: address(0)
            });
            IBlindEscrowBatch(target).createTasks(address(this), tasks);
        }
        return super.transferFrom(from, to, value);
    }
}
