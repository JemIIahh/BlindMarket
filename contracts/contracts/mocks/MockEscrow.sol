// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

contract MockEscrow {
    uint256 public lastTaskId;
    bool public lastWorkerFavored;
    uint256 public resolveCount;
    bool public shouldRevert;

    function setShouldRevert(bool v) external {
        shouldRevert = v;
    }

    function resolveDispute(uint256 taskId, bool workerFavored) external {
        require(!shouldRevert, "escrow reverted");
        lastTaskId = taskId;
        lastWorkerFavored = workerFavored;
        resolveCount++;
    }
}
