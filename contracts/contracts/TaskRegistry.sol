// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts-upgradeable/utils/PausableUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";

/**
 * @title TaskRegistry
 * @author BlindMarket Team
 * @notice On-chain index for task discovery. Stores only metadata — never content.
 *         Workers browse by category, location zone, and reward.
 *         Task instructions remain encrypted on 0G Storage.
 *
 * @dev Security measures:
 *      - Existence tracking via separate mapping to prevent default-value bugs
 *      - O(1) open task counter (no unbounded loops for counting)
 *      - 2-step admin transfer
 *      - Pausable for emergency stops
 */
contract TaskRegistry is Initializable, PausableUpgradeable, UUPSUpgradeable {

    struct TaskMeta {
        uint256 taskId;
        address agent;
        string category;
        string locationZone;
        uint256 reward;
        uint256 createdAt;
        bool isOpen;
    }

    // ── State ──

    TaskMeta[] public taskList;
    mapping(uint256 => uint256) public taskIdToIndex;  // taskId → index in taskList
    mapping(uint256 => bool) public taskExists;        // prevents default-value bugs
    mapping(address => bool) public authorizedPublishers;
    uint256 public openTaskCount;                      // O(1) counter

    address public admin;
    address public pendingAdmin;

    // ── Events ──

    event TaskPublished(uint256 indexed taskId, address indexed agent, string category, string locationZone, uint256 reward);
    event TaskClosed(uint256 indexed taskId);
    event PublisherAuthorized(address indexed publisher);
    event PublisherRevoked(address indexed publisher);
    event AdminTransferProposed(address indexed currentAdmin, address indexed pendingAdmin);
    event AdminTransferCompleted(address indexed oldAdmin, address indexed newAdmin);

    // ── Errors ──

    error NotAdmin();
    error NotPendingAdmin();
    error NotAuthorized();
    error ZeroAddress();
    error TaskNotFound();
    error TaskAlreadyExists();
    error TaskAlreadyClosed();

    // ── Modifiers ──

    modifier onlyAdmin() {
        if (msg.sender != admin) revert NotAdmin();
        _;
    }

    modifier onlyAuthorized() {
        if (!authorizedPublishers[msg.sender]) revert NotAuthorized();
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
     * @notice Publish task metadata for discovery. Called by BlindEscrow on task creation.
     */
    function publishTask(
        uint256 taskId,
        address agent,
        string calldata category,
        string calldata locationZone,
        uint256 reward
    ) external onlyAuthorized whenNotPaused {
        if (taskExists[taskId]) revert TaskAlreadyExists();

        uint256 index = taskList.length;
        taskIdToIndex[taskId] = index;
        taskExists[taskId] = true;

        taskList.push(TaskMeta({
            taskId: taskId,
            agent: agent,
            category: category,
            locationZone: locationZone,
            reward: reward,
            createdAt: block.timestamp,
            isOpen: true
        }));

        openTaskCount += 1;

        emit TaskPublished(taskId, agent, category, locationZone, reward);
    }

    /**
     * @notice Close a task listing. Called when task is assigned, completed, or cancelled.
     */
    function closeTask(uint256 taskId) external onlyAuthorized whenNotPaused {
        if (!taskExists[taskId]) revert TaskNotFound();

        uint256 index = taskIdToIndex[taskId];
        TaskMeta storage meta = taskList[index];

        if (!meta.isOpen) revert TaskAlreadyClosed();

        meta.isOpen = false;
        openTaskCount -= 1;

        emit TaskClosed(taskId);
    }

    // ── View Functions ──

    /**
     * @notice Get total number of tasks ever published.
     */
    function totalTasks() external view returns (uint256) {
        return taskList.length;
    }

    /**
     * @notice Get a page of open tasks. Returns up to `limit` tasks starting from `offset`.
     * @dev Uses two-pass approach: first count (via openTaskCount O(1)), then collect.
     *      The collection loop is still O(n) worst-case but bounded by `limit`.
     */
    function getOpenTasks(uint256 offset, uint256 limit) external view returns (TaskMeta[] memory) {
        if (offset >= openTaskCount) {
            return new TaskMeta[](0);
        }

        uint256 resultSize = limit;
        if (offset + limit > openTaskCount) {
            resultSize = openTaskCount - offset;
        }

        TaskMeta[] memory result = new TaskMeta[](resultSize);
        uint256 found = 0;
        uint256 skipped = 0;

        for (uint256 i = 0; i < taskList.length && found < resultSize; i++) {
            if (taskList[i].isOpen) {
                if (skipped >= offset) {
                    result[found] = taskList[i];
                    found++;
                } else {
                    skipped++;
                }
            }
        }

        return result;
    }

    /**
     * @notice Get a single task's metadata by taskId.
     */
    function getTaskMeta(uint256 taskId) external view returns (TaskMeta memory) {
        if (!taskExists[taskId]) revert TaskNotFound();
        return taskList[taskIdToIndex[taskId]];
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

    function authorizePublisher(address publisher) external onlyAdmin {
        if (publisher == address(0)) revert ZeroAddress();
        authorizedPublishers[publisher] = true;
        emit PublisherAuthorized(publisher);
    }

    function revokePublisher(address publisher) external onlyAdmin {
        authorizedPublishers[publisher] = false;
        emit PublisherRevoked(publisher);
    }

    function pause() external onlyAdmin {
        _pause();
    }

    function unpause() external onlyAdmin {
        _unpause();
    }
}
