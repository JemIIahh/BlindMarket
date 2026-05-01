// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts-upgradeable/utils/PausableUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";

/**
 * @title BlindReputation
 * @author BlindMarket Team
 * @notice Anonymous reputation system. Scores are linked to wallet addresses
 *         but no name, location, or PII is stored on-chain.
 *         Only authorized raters (escrow contracts) can rate.
 *
 * @dev Security measures:
 *      - Per-task deduplication: cannot rate the same worker for the same task twice
 *      - Task-correlated disputes for auditability
 *      - 2-step admin transfer
 *      - Pausable for emergency stops
 */
contract BlindReputation is Initializable, PausableUpgradeable, UUPSUpgradeable {

    struct Reputation {
        uint256 tasksCompleted;
        uint256 totalScore;     // cumulative rating points (1-5 per task)
        uint256 disputes;
    }

    // ── State ──

    mapping(address => Reputation) public reputations;
    mapping(address => bool) public authorizedRaters;
    mapping(bytes32 => bool) public ratedTasks; // keccak256(worker, taskId) → already rated

    address public admin;
    address public pendingAdmin;

    // ── Events ──

    event Rated(address indexed worker, address indexed rater, uint8 score, uint256 indexed taskId);
    event DisputeRecorded(address indexed worker, uint256 indexed taskId);
    event RaterAuthorized(address indexed rater);
    event RaterRevoked(address indexed rater);
    event AdminTransferProposed(address indexed currentAdmin, address indexed pendingAdmin);
    event AdminTransferCompleted(address indexed oldAdmin, address indexed newAdmin);

    // ── Errors ──

    error NotAdmin();
    error NotPendingAdmin();
    error NotAuthorizedRater();
    error InvalidScore();
    error ZeroAddress();
    error AlreadyRated();

    // ── Modifiers ──

    modifier onlyAdmin() {
        if (msg.sender != admin) revert NotAdmin();
        _;
    }

    modifier onlyAuthorized() {
        if (!authorizedRaters[msg.sender]) revert NotAuthorizedRater();
        _;
    }

    // ── Constructor ──

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    function initialize() external initializer {
        __Pausable_init();
        admin = msg.sender;
    }

    function _authorizeUpgrade(address) internal override onlyAdmin {}

    // ── Core Functions ──

    /**
     * @notice Rate a worker after task completion. Score 1-5.
     *         Only callable by authorized contracts (BlindEscrow).
     *         Each (worker, taskId) pair can only be rated once.
     */
    function rate(address worker, uint8 score, uint256 taskId) external onlyAuthorized whenNotPaused {
        if (score < 1 || score > 5) revert InvalidScore();
        if (worker == address(0)) revert ZeroAddress();

        bytes32 key = keccak256(abi.encodePacked(worker, taskId));
        if (ratedTasks[key]) revert AlreadyRated();
        ratedTasks[key] = true;

        Reputation storage r = reputations[worker];
        r.tasksCompleted += 1;
        r.totalScore += score;

        emit Rated(worker, msg.sender, score, taskId);
    }

    /**
     * @notice Record a dispute against a worker for a specific task.
     */
    function recordDispute(address worker, uint256 taskId) external onlyAuthorized whenNotPaused {
        if (worker == address(0)) revert ZeroAddress();
        reputations[worker].disputes += 1;
        emit DisputeRecorded(worker, taskId);
    }

    // ── View Functions ──

    /**
     * @notice Get anonymous reputation for a worker.
     *         Returns stats only — no name, no location, no PII.
     * @return tasksCompleted Number of tasks completed
     * @return avgScore Average rating scaled by 100 (e.g., 450 = 4.50)
     * @return disputes Number of disputes recorded
     */
    function getReputation(address worker) external view returns (
        uint256 tasksCompleted,
        uint256 avgScore,
        uint256 disputes
    ) {
        Reputation memory r = reputations[worker];
        tasksCompleted = r.tasksCompleted;
        avgScore = r.tasksCompleted > 0 ? (r.totalScore * 100) / r.tasksCompleted : 0;
        disputes = r.disputes;
    }

    /**
     * @notice Check if a worker has been rated for a specific task.
     */
    function hasBeenRated(address worker, uint256 taskId) external view returns (bool) {
        return ratedTasks[keccak256(abi.encodePacked(worker, taskId))];
    }

    // ── Admin Functions ──

    function proposeAdmin(address _newAdmin) external onlyAdmin {
        if (_newAdmin == address(0)) revert ZeroAddress();
        pendingAdmin = _newAdmin;
        emit AdminTransferProposed(admin, _newAdmin);
    }

    function acceptAdmin() external {
        if (msg.sender != pendingAdmin) revert NotPendingAdmin();
        emit AdminTransferCompleted(admin, pendingAdmin);
        admin = pendingAdmin;
        pendingAdmin = address(0);
    }

    function authorizeRater(address rater) external onlyAdmin {
        if (rater == address(0)) revert ZeroAddress();
        authorizedRaters[rater] = true;
        emit RaterAuthorized(rater);
    }

    function revokeRater(address rater) external onlyAdmin {
        authorizedRaters[rater] = false;
        emit RaterRevoked(rater);
    }

    function pause() external onlyAdmin {
        _pause();
    }

    function unpause() external onlyAdmin {
        _unpause();
    }
}
