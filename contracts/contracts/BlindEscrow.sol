// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuardTransient.sol";
import "@openzeppelin/contracts-upgradeable/utils/PausableUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";

import "./interfaces/IBlindReputation.sol";
import "./interfaces/ITaskRegistry.sol";

/**
 * @title BlindEscrow
 * @author BlindMarket Team
 * @notice Privacy-first escrow for encrypted task bounties.
 *         Task content is never stored on-chain — only encrypted blob hashes.
 *         Payment releases on TEE-verified evidence (0G Sealed Inference).
 *
 * @dev Security measures:
 *      - ReentrancyGuard on all token-moving functions
 *      - Pausable for emergency stops
 *      - Strict CEI (Checks-Effects-Interactions) pattern
 *      - 2-step admin transfer to prevent accidental lockout
 *      - Token whitelist to prevent malicious ERC-20 interactions
 *      - Deadline enforcement to prevent indefinite fund locking
 *      - On-chain integration with TaskRegistry + BlindReputation
 */
contract BlindEscrow is Initializable, ReentrancyGuardTransient, PausableUpgradeable, UUPSUpgradeable {
    using SafeERC20 for IERC20;

    // ── Types ──

    enum TaskStatus {
        Funded,       // 0 — Agent created task, funds locked
        Assigned,     // 1 — Worker selected, instructions decrypted for them
        Submitted,    // 2 — Worker submitted encrypted evidence
        Verified,     // 3 — Sealed Inference verified evidence (failed)
        Completed,    // 4 — Payment released (verified + passed)
        Cancelled,    // 5 — Agent cancelled, funds refunded
        Disputed      // 6 — Under dispute review
    }

    struct Task {
        address agent;          // who created and funded
        address worker;         // assigned worker (address(0) if unassigned)
        address token;          // payment token (whitelisted ERC-20)
        uint256 amount;         // escrowed amount
        bytes32 taskHash;       // hash of encrypted task blob on 0G Storage
        bytes32 evidenceHash;   // hash of encrypted evidence blob
        TaskStatus status;
        string category;        // "photography", "verification", etc.
        string locationZone;    // approximate zone, not precise coords
        uint256 createdAt;
        uint256 deadline;       // block.timestamp after which agent can reclaim
        uint8 submissionAttempts; // how many times worker has submitted
    }

    // ── Constants ──

    uint256 public constant MAX_FEE_BPS = 3000;      // 30% hard cap
    uint8 public constant MAX_SUBMISSION_ATTEMPTS = 3; // max resubmissions after failed verification
    uint256 public constant MIN_DEADLINE = 1 hours;    // minimum task duration
    uint256 public constant MAX_DEADLINE = 90 days;    // maximum task duration

    // ── State ──

    uint256 public nextTaskId;
    mapping(uint256 => Task) internal _tasks;

    address public admin;
    address public pendingAdmin;       // 2-step admin transfer
    address public treasury;
    address public verifier;           // 0G Sealed Inference callback address
    uint256 public feeBps;             // 15% = 1500 basis points

    mapping(address => bool) public allowedTokens;  // token whitelist

    // Optional integrations (address(0) = disabled)
    IBlindReputation public reputationContract;
    ITaskRegistry public taskRegistry;

    // ── Events ──

    event TaskCreated(uint256 indexed taskId, address indexed agent, address token, uint256 amount, bytes32 taskHash, string category, string locationZone, uint256 deadline);
    event WorkerAssigned(uint256 indexed taskId, address indexed worker);
    event EvidenceSubmitted(uint256 indexed taskId, address indexed worker, bytes32 evidenceHash, uint8 attempt);
    event VerificationCompleted(uint256 indexed taskId, bool passed);
    event TaskCompleted(uint256 indexed taskId, uint256 workerPayout, uint256 platformFee);
    event TaskCancelled(uint256 indexed taskId, uint256 refundAmount);
    event TaskDisputed(uint256 indexed taskId, address indexed initiator);
    event DisputeResolved(uint256 indexed taskId, bool workerFavored);
    event DeadlineExpired(uint256 indexed taskId, uint256 refundAmount);

    event TreasuryUpdated(address indexed oldTreasury, address indexed newTreasury);
    event VerifierUpdated(address indexed oldVerifier, address indexed newVerifier);
    event FeeBpsUpdated(uint256 oldFeeBps, uint256 newFeeBps);
    event TokenAllowed(address indexed token);
    event TokenDisallowed(address indexed token);
    event AdminTransferProposed(address indexed currentAdmin, address indexed pendingAdmin);
    event AdminTransferCompleted(address indexed oldAdmin, address indexed newAdmin);
    event ReputationContractUpdated(address indexed oldContract, address indexed newContract);
    event TaskRegistryUpdated(address indexed oldRegistry, address indexed newRegistry);

    // ── Errors (custom errors are cheaper than string reverts) ──

    error NotAdmin();
    error NotAgent();
    error NotWorker();
    error NotVerifier();
    error NotPendingAdmin();
    error ZeroAddress();
    error ZeroAmount();
    error EmptyHash();
    error TokenNotAllowed();
    error InvalidDeadline();
    error InvalidStatus(TaskStatus current, TaskStatus required);
    error SelfAssignment();
    error DeadlineNotReached();
    error DeadlineReached();
    error MaxSubmissionAttemptsReached();
    error FeeExceedsMax();

    // ── Modifiers ──

    modifier onlyAdmin() {
        if (msg.sender != admin) revert NotAdmin();
        _;
    }

    modifier onlyAgent(uint256 taskId) {
        if (msg.sender != _tasks[taskId].agent) revert NotAgent();
        _;
    }

    modifier onlyWorker(uint256 taskId) {
        if (msg.sender != _tasks[taskId].worker) revert NotWorker();
        _;
    }

    modifier onlyVerifier() {
        if (msg.sender != verifier) revert NotVerifier();
        _;
    }

    // ── Constructor ──

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    function initialize(address _treasury, address _verifier) external initializer {
        if (_treasury == address(0)) revert ZeroAddress();
        if (_verifier == address(0)) revert ZeroAddress();

        __Pausable_init();

        admin = msg.sender;
        treasury = _treasury;
        verifier = _verifier;
        nextTaskId = 1;
        feeBps = 1500;
    }

    function _authorizeUpgrade(address) internal override onlyAdmin {}

    // ── Core Functions ──

    /**
     * @notice Agent creates a task and locks payment in escrow.
     * @param taskHash Hash of encrypted task blob stored on 0G Storage
     * @param token ERC-20 token address for payment (must be whitelisted)
     * @param amount Payment amount to lock
     * @param category Task category for discovery
     * @param locationZone Approximate location zone (not precise)
     * @param duration How long (in seconds) the worker has to complete the task
     */
    function createTask(
        bytes32 taskHash,
        address token,
        uint256 amount,
        string calldata category,
        string calldata locationZone,
        uint256 duration
    ) external nonReentrant whenNotPaused returns (uint256 taskId) {
        if (amount == 0) revert ZeroAmount();
        if (taskHash == bytes32(0)) revert EmptyHash();
        if (!allowedTokens[token]) revert TokenNotAllowed();
        if (duration < MIN_DEADLINE || duration > MAX_DEADLINE) revert InvalidDeadline();

        taskId = nextTaskId++;
        uint256 deadline = block.timestamp + duration;

        _tasks[taskId] = Task({
            agent: msg.sender,
            worker: address(0),
            token: token,
            amount: amount,
            taskHash: taskHash,
            evidenceHash: bytes32(0),
            status: TaskStatus.Funded,
            category: category,
            locationZone: locationZone,
            createdAt: block.timestamp,
            deadline: deadline,
            submissionAttempts: 0
        });

        // Interactions last (CEI)
        IERC20(token).safeTransferFrom(msg.sender, address(this), amount);

        // Publish to TaskRegistry if connected
        if (address(taskRegistry) != address(0)) {
            taskRegistry.publishTask(taskId, msg.sender, category, locationZone, amount);
        }

        emit TaskCreated(taskId, msg.sender, token, amount, taskHash, category, locationZone, deadline);
    }

    /**
     * @notice Agent assigns a worker to the task. Only possible while Funded and before deadline.
     * @dev Agent cannot assign themselves to prevent self-dealing.
     */
    function assignWorker(uint256 taskId, address worker) external onlyAgent(taskId) whenNotPaused {
        Task storage t = _tasks[taskId];
        if (t.status != TaskStatus.Funded) revert InvalidStatus(t.status, TaskStatus.Funded);
        if (worker == address(0)) revert ZeroAddress();
        if (worker == msg.sender) revert SelfAssignment();
        if (block.timestamp >= t.deadline) revert DeadlineReached();

        t.worker = worker;
        t.status = TaskStatus.Assigned;

        // Close listing on TaskRegistry
        if (address(taskRegistry) != address(0)) {
            taskRegistry.closeTask(taskId);
        }

        emit WorkerAssigned(taskId, worker);
    }

    /**
     * @notice Worker submits encrypted evidence hash. Allowed while Assigned or after failed Verification (retry).
     */
    function submitEvidence(uint256 taskId, bytes32 evidenceHash) external onlyWorker(taskId) whenNotPaused {
        Task storage t = _tasks[taskId];

        // Allow submission when Assigned OR when Verified (failed — retry)
        bool isAssigned = t.status == TaskStatus.Assigned;
        bool isRetry = t.status == TaskStatus.Verified;

        if (!isAssigned && !isRetry) revert InvalidStatus(t.status, TaskStatus.Assigned);
        if (evidenceHash == bytes32(0)) revert EmptyHash();
        if (block.timestamp >= t.deadline) revert DeadlineReached();

        if (isRetry) {
            if (t.submissionAttempts >= MAX_SUBMISSION_ATTEMPTS) revert MaxSubmissionAttemptsReached();
        }

        t.evidenceHash = evidenceHash;
        t.status = TaskStatus.Submitted;
        t.submissionAttempts += 1;

        emit EvidenceSubmitted(taskId, msg.sender, evidenceHash, t.submissionAttempts);
    }

    /**
     * @notice Called by 0G Sealed Inference verifier after TEE verification.
     *         If passed → releases payment. If failed → moves to Verified for retry or timeout.
     * @dev Strict CEI: all state changes before external calls.
     */
    function completeVerification(uint256 taskId, bool passed) external onlyVerifier nonReentrant whenNotPaused {
        Task storage t = _tasks[taskId];
        if (t.status != TaskStatus.Submitted) revert InvalidStatus(t.status, TaskStatus.Submitted);

        emit VerificationCompleted(taskId, passed);

        if (passed) {
            // ── Effects (all state changes first) ──
            uint256 fee = (t.amount * feeBps) / 10_000;
            uint256 payout = t.amount - fee;
            t.status = TaskStatus.Completed;

            // ── Interactions (external calls last) ──
            IERC20(t.token).safeTransfer(t.worker, payout);
            if (fee > 0) {
                IERC20(t.token).safeTransfer(treasury, fee);
            }

            // Record reputation if connected
            if (address(reputationContract) != address(0)) {
                reputationContract.rate(t.worker, 5, taskId);
            }

            emit TaskCompleted(taskId, payout, fee);
        } else {
            // Failed verification — worker can retry if attempts remain
            t.status = TaskStatus.Verified;

            // Record dispute if max attempts reached
            if (t.submissionAttempts >= MAX_SUBMISSION_ATTEMPTS && address(reputationContract) != address(0)) {
                reputationContract.recordDispute(t.worker, taskId);
            }
        }
    }

    /**
     * @notice Agent cancels task. Only possible while Funded (before worker assigned).
     */
    function cancelTask(uint256 taskId) external onlyAgent(taskId) nonReentrant whenNotPaused {
        Task storage t = _tasks[taskId];
        if (t.status != TaskStatus.Funded) revert InvalidStatus(t.status, TaskStatus.Funded);

        // Effects
        t.status = TaskStatus.Cancelled;

        // Interactions
        IERC20(t.token).safeTransfer(t.agent, t.amount);

        // Close listing if connected
        if (address(taskRegistry) != address(0)) {
            taskRegistry.closeTask(taskId);
        }

        emit TaskCancelled(taskId, t.amount);
    }

    /**
     * @notice Agent reclaims funds after deadline expires.
     *         Works for Assigned, Submitted, or Verified (failed) tasks.
     *         Prevents funds from being locked forever if worker ghosts.
     */
    function claimTimeout(uint256 taskId) external onlyAgent(taskId) nonReentrant {
        Task storage t = _tasks[taskId];
        if (block.timestamp < t.deadline) revert DeadlineNotReached();

        // Only allow timeout on active-but-incomplete statuses
        bool canTimeout = t.status == TaskStatus.Assigned ||
                          t.status == TaskStatus.Submitted ||
                          t.status == TaskStatus.Verified;

        if (!canTimeout) revert InvalidStatus(t.status, TaskStatus.Assigned);

        // Effects
        t.status = TaskStatus.Cancelled;

        // Interactions
        IERC20(t.token).safeTransfer(t.agent, t.amount);

        emit DeadlineExpired(taskId, t.amount);
    }

    /**
     * @notice Agent or worker can raise a dispute. Moves task to Disputed status.
     *         Disputes are resolved by admin via resolveDispute().
     */
    function raiseDispute(uint256 taskId) external whenNotPaused {
        Task storage t = _tasks[taskId];
        bool isSender = msg.sender == t.agent || msg.sender == t.worker;
        require(isSender, "not party to task");

        // Can dispute during Submitted or Verified (failed)
        bool canDispute = t.status == TaskStatus.Submitted || t.status == TaskStatus.Verified;
        if (!canDispute) revert InvalidStatus(t.status, TaskStatus.Submitted);

        t.status = TaskStatus.Disputed;
        emit TaskDisputed(taskId, msg.sender);
    }

    /**
     * @notice Admin resolves a dispute. If workerFavored, pays worker. Otherwise refunds agent.
     */
    function resolveDispute(uint256 taskId, bool workerFavored) external onlyAdmin nonReentrant {
        Task storage t = _tasks[taskId];
        if (t.status != TaskStatus.Disputed) revert InvalidStatus(t.status, TaskStatus.Disputed);

        if (workerFavored) {
            uint256 fee = (t.amount * feeBps) / 10_000;
            uint256 payout = t.amount - fee;
            t.status = TaskStatus.Completed;

            IERC20(t.token).safeTransfer(t.worker, payout);
            if (fee > 0) {
                IERC20(t.token).safeTransfer(treasury, fee);
            }

            if (address(reputationContract) != address(0)) {
                reputationContract.rate(t.worker, 3, taskId); // neutral score for disputed completion
            }

            emit DisputeResolved(taskId, true);
            emit TaskCompleted(taskId, payout, fee);
        } else {
            t.status = TaskStatus.Cancelled;

            IERC20(t.token).safeTransfer(t.agent, t.amount);

            if (address(reputationContract) != address(0)) {
                reputationContract.recordDispute(t.worker, taskId);
            }

            emit DisputeResolved(taskId, false);
            emit TaskCancelled(taskId, t.amount);
        }
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

    function setTreasury(address _treasury) external onlyAdmin {
        if (_treasury == address(0)) revert ZeroAddress();
        emit TreasuryUpdated(treasury, _treasury);
        treasury = _treasury;
    }

    function setVerifier(address _verifier) external onlyAdmin {
        if (_verifier == address(0)) revert ZeroAddress();
        emit VerifierUpdated(verifier, _verifier);
        verifier = _verifier;
    }

    function setFeeBps(uint256 _feeBps) external onlyAdmin {
        if (_feeBps > MAX_FEE_BPS) revert FeeExceedsMax();
        emit FeeBpsUpdated(feeBps, _feeBps);
        feeBps = _feeBps;
    }

    function allowToken(address token) external onlyAdmin {
        if (token == address(0)) revert ZeroAddress();
        allowedTokens[token] = true;
        emit TokenAllowed(token);
    }

    function disallowToken(address token) external onlyAdmin {
        allowedTokens[token] = false;
        emit TokenDisallowed(token);
    }

    function setReputationContract(address _reputation) external onlyAdmin {
        emit ReputationContractUpdated(address(reputationContract), _reputation);
        reputationContract = IBlindReputation(_reputation);
    }

    function setTaskRegistry(address _registry) external onlyAdmin {
        emit TaskRegistryUpdated(address(taskRegistry), _registry);
        taskRegistry = ITaskRegistry(_registry);
    }

    function pause() external onlyAdmin {
        _pause();
    }

    function unpause() external onlyAdmin {
        _unpause();
    }

    // ── View Functions ──

    function getTask(uint256 taskId) external view returns (Task memory) {
        return _tasks[taskId];
    }

    function isTaskExpired(uint256 taskId) external view returns (bool) {
        return block.timestamp >= _tasks[taskId].deadline;
    }
}
