// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/access/Ownable2Step.sol";

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
contract AgentFactory is Ownable2Step {
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
    event EmergencyWithdrawal(address indexed to, uint256 amount);

    /// Agent funding has no on-chain delivery path yet — see {deployAgent}.
    error AgentFundingNotSupported();

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
     * @notice Deploy an agent by paying the USDC deploy fee.
     * @param usdcAmount Additional agent funding. Must be 0 — see below.
     * @dev User must approve USDC first. The fee goes straight to treasury and
     *      nothing is retained by this contract.
     *
     *      `usdcAmount` is reserved for funding the agent's own wallet, which
     *      does not exist on-chain at this point: the backend generates it in
     *      response to the AgentDeployed event. There is therefore no address
     *      to forward funding to, and any non-zero amount would sit in this
     *      contract with no exit but {emergencyWithdraw}. Rather than strand
     *      user funds silently, we reject it until a delivery path exists.
     *      The parameter is kept so the ABI stays stable for the deployed
     *      Sepolia factory and the frontend, which already passes 0.
     */
    function deployAgent(uint256 usdcAmount) external {
        if (usdcAmount != 0) revert AgentFundingNotSupported();
        require(deployFeeUsdc > 0, "Deploy not enabled");

        nonce++;

        // Fee goes directly to treasury — this contract never holds user funds.
        usdc.safeTransferFrom(msg.sender, treasury, deployFeeUsdc);

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
     * @notice Emergency withdraw stuck USDC (only owner). With {deployAgent}
     *         forwarding the fee straight to treasury, this should only ever
     *         move tokens sent here by mistake.
     */
    function emergencyWithdraw(uint256 amount) external onlyOwner {
        emit EmergencyWithdrawal(owner(), amount);
        usdc.safeTransfer(owner(), amount);
    }
}
