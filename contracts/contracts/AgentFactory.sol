// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/access/Ownable.sol";

/**
 * @title AgentFactory
 * @notice Deploys agents on BlindMarket. Users pay USDC, get an agent.
 * @dev Trustless: USDC goes to treasury, backend only listens for events.
 *      Each agent owns its wallet — backend never signs for agents.
 *
 *      Flow:
 *      1. User calls deployAgent(usdcAmount) → USDC transferred to treasury
 *      2. Contract emits AgentDeployed(user, usdcAmount, nonce)
 *      3. Backend listens → creates agent record, generates wallet
 *      4. Agent signs its own 0G transactions (decentralized)
 */
contract AgentFactory is Ownable {
    using SafeERC20 for IERC20;

    IERC20 public usdc;
    address public treasury;
    uint256 public deployFeeUsdc; // flat fee per agent deploy (6 decimals)

    uint256 public nonce; // incrementing id for event tracking

    event AgentDeployed(
        address indexed user,
        uint256 usdcAmount,
        uint256 nonce,
        uint256 timestamp
    );

    event TreasuryUpdated(address newTreasury);
    event DeployFeeUpdated(uint256 newFee);

    constructor(
        address _usdc,
        address _treasury,
        uint256 _deployFeeUsdc
    ) Ownable(msg.sender) {
        require(_usdc != address(0), "USDC required");
        require(_treasury != address(0), "Treasury required");
        usdc = IERC20(_usdc);
        treasury = _treasury;
        deployFeeUsdc = _deployFeeUsdc;
    }

    /**
     * @notice Deploy an agent by paying USDC
     * @param usdcAmount Amount of USDC to pay (after fee deduction)
     * @dev User must approve USDC first. Fee goes to treasury.
     */
    function deployAgent(uint256 usdcAmount) external {
        require(usdcAmount > 0, "Amount must be > 0");
        require(deployFeeUsdc > 0, "Deploy not enabled");

        nonce++;

        // Transfer total (fee + amount) from user to this contract
        uint256 total = deployFeeUsdc + usdcAmount;
        usdc.safeTransferFrom(msg.sender, address(this), total);

        // Forward fee to treasury
        usdc.safeTransfer(treasury, deployFeeUsdc);

        // Emit event for backend to pick up
        emit AgentDeployed(msg.sender, usdcAmount, nonce, block.timestamp);
    }

    /**
     * @notice Get the total USDC needed for deploy (fee + amount)
     */
    function getTotalCost(uint256 usdcAmount) external view returns (uint256) {
        return deployFeeUsdc + usdcAmount;
    }

    // ── Admin ──

    function setTreasury(address _treasury) external onlyOwner {
        require(_treasury != address(0), "Zero address");
        treasury = _treasury;
        emit TreasuryUpdated(_treasury);
    }

    function setDeployFee(uint256 _fee) external onlyOwner {
        deployFeeUsdc = _fee;
        emit DeployFeeUpdated(_fee);
    }

    /**
     * @notice Emergency withdraw stuck USDC (only owner)
     */
    function emergencyWithdraw(uint256 amount) external onlyOwner {
        usdc.safeTransfer(owner(), amount);
    }
}
