// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// Test double for IBlindReputation that accepts every call and logs it, so a
/// test sees each rating the escrow asks for, including ones BlindReputation
/// itself would reject (a score of 0) and the escrow's try/catch would hide.
contract RecordingReputation {
    event RateCalled(address worker, uint8 score, uint256 taskId);
    event DisputeCalled(address worker, uint256 taskId);

    function rate(address worker, uint8 score, uint256 taskId) external {
        emit RateCalled(worker, score, taskId);
    }

    function recordDispute(address worker, uint256 taskId) external {
        emit DisputeCalled(worker, taskId);
    }

    function getReputation(address) external pure returns (uint256, uint256, uint256) {
        return (0, 0, 0);
    }
}
