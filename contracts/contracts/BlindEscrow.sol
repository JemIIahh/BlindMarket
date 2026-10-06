// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuardTransient.sol";
import "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import "@openzeppelin/contracts/utils/cryptography/MessageHashUtils.sol";
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
        uint256 deadline;       // creation-time deadline; effectiveDeadline() adds the time the escrow spent paused
        uint8 submissionAttempts; // how many times worker has submitted
        uint256 disputedAt;     // block.timestamp raiseDispute was called (0 = never disputed / pre-upgrade)
    }

    /// One task of a createTasks batch: the createTask / createTaskWithVerifier
    /// arguments minus the token, which the whole batch shares.
    struct TaskInput {
        bytes32 taskHash;
        uint256 amount;
        string category;
        string locationZone;
        uint256 duration;
        address verifierAgent;  // address(0): no per-task verifier
    }

    /// Who picks an open task's winner first, chosen at createTaskOpen.
    enum PickMode {
        AgentManaged,   // 0 — the task verifier picks from the deadline
        CreatorReview   // 1 — the poster picks for its creatorWindow, then the task verifier
    }

    /// The phases of an open task after it is posted, in order. Each judge
    /// may act only in its own phase; each phase but the last is bounded.
    enum OpenPhase {
        Submissions,   // 0 — until the effective deadline: submitOpen
        CreatorPick,   // 1 — CreatorReview only, for creatorWindow: the poster's selectWinner
        VerifierPick,  // 2 — VERIFIER_PICK_WINDOW: the task verifier's selectWinnerByVerifier
        BackupPick,    // 3 — BACKUP_PICK_WINDOW: the global verifier's selectWinnerByBackup or voidOpenTask
        AdminResolve,  // 4 — from then on: the admin's resolveOpenTask
        Closed         // 5 — a winner was paid or the task was refunded
    }

    /// Who closed an open task, by picking its winner or voiding it.
    enum Judge {
        None,          // 0 — not closed by a judge (still open, or cancelled with no submission)
        Creator,       // 1 — the poster: selectWinner, or a void with no submission
        TaskVerifier,  // 2 — the task's own verifier: selectWinnerByVerifier
        Backup,        // 3 — the global verifier: selectWinnerByBackup or voidOpenTask
        Admin          // 4 — resolveOpenTask
    }

    /// An open-submission task's settings and outcome (createTaskOpen).
    struct OpenTask {
        bool open;              // the task takes open submissions
        PickMode mode;
        uint32 creatorWindow;   // seconds; 0 for AgentManaged
        Judge closedBy;         // set when a winner is picked or the task voided
    }

    // ── Constants ──

    uint256 public constant MAX_FEE_BPS = 3000;      // 30% hard cap
    uint8 public constant MAX_SUBMISSION_ATTEMPTS = 3; // max resubmissions after failed verification
    uint256 public constant MIN_DEADLINE = 1 hours;    // minimum task duration
    uint256 public constant MAX_DEADLINE = 90 days;    // maximum task duration
    uint256 public constant DISPUTE_WINDOW = 14 days;  // time after a dispute is raised before claimTimeout can recover it (or, for escalated unjudged work, releaseUnjudgedWork)
    uint256 public constant APPEAL_WINDOW = 3 days;    // time after a failed verdict in which the worker may still raiseDispute, even past the deadline
    uint256 public constant MAX_BATCH = 50;            // most tasks one createTasks call creates; clients read it to detect batch support
    uint256 public constant MIN_CREATOR_WINDOW = 1 hours;     // shortest CreatorReview pick window
    uint256 public constant MAX_CREATOR_WINDOW = 7 days;      // longest CreatorReview pick window
    uint256 public constant VERIFIER_PICK_WINDOW = 48 hours;  // the task verifier's turn to pick an open task's winner
    uint256 public constant BACKUP_PICK_WINDOW = 48 hours;    // the global verifier's turn, before the admin's

    // ── State ──

    uint256 public nextTaskId;
    mapping(uint256 => Task) internal _tasks;

    address public admin;
    address public pendingAdmin;       // 2-step admin transfer
    address public treasury;
    address public verifier;           // 0G Sealed Inference callback address
    uint256 public feeBps;             // 10% = 1000 basis points

    mapping(address => bool) public allowedTokens;  // token whitelist

    // Optional integrations (address(0) = disabled)
    IBlindReputation public reputationContract;
    ITaskRegistry public taskRegistry;

    // Per-task verifier (verificationMode='agent'). Set by the poster at task
    // creation; address(0) means "use the global verifier" (the auto/manual
    // relay path, and every task created before this upgrade). Appended as a
    // trailing state variable for UUPS storage-layout safety.
    mapping(uint256 => address) public taskVerifier;

    // 0G TEE signer address — registered on-chain so completeVerificationWithTEE
    // can verify TEE attestation signatures via ecrecover. Set by admin.
    // address(0) = TEE path disabled (legacy address-gated flow only).
    address public teeSigner;

    // Time of the task's latest passed=false verdict (0 = never failed, or
    // failed before this upgrade). The worker may appeal it with raiseDispute
    // for APPEAL_WINDOW after it, even past the deadline, and claimTimeout on
    // a Verified task waits that window out. Trailing state, UUPS-append-only.
    mapping(uint256 => uint256) public failedVerdictAt;

    // True once claimTimeout escalated delivered-but-never-judged work (a
    // Submitted task past its deadline) to Disputed. Such a dispute never
    // falls back to the poster: the admin rules on it with resolveDispute, or,
    // if no ruling comes within DISPUTE_WINDOW, the worker collects it with
    // releaseUnjudgedWork. Trailing state, UUPS-append-only.
    mapping(uint256 => bool) public unjudgedEscalation;

    // Pause accounting. An emergency pause freezes every worker and verifier
    // action, so it must not let a task's clock run out meanwhile: each
    // deadline (and the dispute / appeal windows) moves by the time the escrow
    // has spent paused since the task was created. Trailing state,
    // UUPS-append-only.
    uint256 public pausedTotal;  // seconds spent in completed pauses (since this upgrade)
    uint256 public pausedSince;  // start of the running pause; 0 while unpaused, or while unknown (installed mid-pause, see recordPauseStart)
    mapping(uint256 => uint256) internal _pausedTotalAtCreate; // pausedTotal when each task was created

    // Per-token minimum task amount for a passed verification to earn a
    // BlindReputation rating (0 = no minimum beyond a non-zero platform fee).
    // Trailing state, UUPS-append-only.
    mapping(address => uint256) public minRatedAmount;

    // Open submission (docs/OPEN-SUBMISSION-TASKS.md): anyone but the poster
    // and the judges submits one result per address before the deadline, and
    // a judge picks one winner. Nothing iterates submissions: a submission is
    // one mapping slot plus a counter, a pick checks the winner's slot, so
    // both cost the same at any count. Trailing state, UUPS-append-only.
    mapping(uint256 => OpenTask) internal _openTasks;
    mapping(uint256 => uint256) public submissionCount;                    // submissions so far
    mapping(uint256 => mapping(address => bytes32)) public submissionOf;   // evidence hash per submitter; 0 = none
    mapping(uint256 => bytes32) public scorecardOf;                        // hash of the judge's scorecard, anchored with the pick or void

    // ── Events ──

    event TaskCreated(uint256 indexed taskId, address indexed agent, address token, uint256 amount, bytes32 taskHash, string category, string locationZone, uint256 deadline);
    event TaskVerifierSet(uint256 indexed taskId, address indexed verifier);
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
    event TeeSignerUpdated(address indexed oldSigner, address indexed newSigner);
    event TEESettled(uint256 indexed taskId, bool passed, address indexed teeSigner);
    event UnjudgedWorkEscalated(uint256 indexed taskId);
    event UnjudgedWorkReleased(uint256 indexed taskId, uint256 workerPayout, uint256 platformFee);
    event PauseStartRecorded(uint256 pausedAt);
    event MinRatedAmountUpdated(address indexed token, uint256 oldAmount, uint256 newAmount);
    event OpenTaskCreated(uint256 indexed taskId, PickMode mode, uint256 creatorWindow);
    event OpenSubmission(uint256 indexed taskId, address indexed submitter, bytes32 evidenceHash, uint256 count);
    event WinnerSelected(uint256 indexed taskId, address indexed winner, Judge judge, bytes32 scorecardHash);
    event OpenTaskVoided(uint256 indexed taskId, Judge judge, bytes32 scorecardHash);

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
    error DisputeWindowActive();
    error MaxSubmissionAttemptsReached();
    error FeeExceedsMax();
    error InvalidTEESignature();
    error TEESignerNotSet();
    error AppealWindowActive();
    error EscalatedForAdjudication();
    error NotEscalated();
    error InvalidPauseStart();
    error EmptyBatch();
    error BatchTooLarge();
    error InvalidPickWindow();
    error NotOpenTask();
    error OpenTaskUnsupported();
    error AlreadySubmitted();
    error HasSubmissions();
    error NoSubmission();
    error WrongPhase(OpenPhase current);

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
        feeBps = 1000;
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
    ) external payable nonReentrant whenNotPaused returns (uint256) {
        return _createTask(taskHash, token, amount, category, locationZone, duration, address(0));
    }

    /**
     * @notice Like createTask, but designates a per-task verifier
     *         (verificationMode='agent'). Only `verifierAgent` can call
     *         completeVerification for this task — settlement is trustless: the
     *         platform cannot fake or override the verdict. The verifier cannot
     *         be the poster (self-dealing) and (enforced at completeVerification)
     *         cannot be the assigned worker.
     */
    function createTaskWithVerifier(
        bytes32 taskHash,
        address token,
        uint256 amount,
        string calldata category,
        string calldata locationZone,
        uint256 duration,
        address verifierAgent
    ) external payable nonReentrant whenNotPaused returns (uint256) {
        return _createTask(taskHash, token, amount, category, locationZone, duration, verifierAgent);
    }

    /**
     * @notice Creates up to MAX_BATCH tasks in one transaction, all paid in the
     *         same ERC-20 token, and pulls their combined amount in a single
     *         transfer. Each task is validated and recorded exactly as
     *         createTask / createTaskWithVerifier would record it (a non-zero
     *         `verifierAgent` makes it an agent-verified task), and gets its
     *         own TaskCreated (plus TaskVerifierSet) in input order. Task ids
     *         are consecutive from the returned `firstTaskId`. Any invalid task
     *         reverts the whole batch: nothing is recorded and nothing is paid.
     * @dev ERC-20 only. A native-token batch would need msg.value to equal the
     *      sum; the single-task path covers native tokens.
     */
    function createTasks(address token, TaskInput[] calldata tasks)
        external
        payable
        nonReentrant
        whenNotPaused
        returns (uint256 firstTaskId)
    {
        uint256 count = tasks.length;
        if (count == 0) revert EmptyBatch();
        if (count > MAX_BATCH) revert BatchTooLarge();
        if (token == address(0)) revert TokenNotAllowed();
        // Same error the single path uses for value sent with an ERC-20 task.
        if (msg.value != 0) revert ZeroAmount();

        firstTaskId = nextTaskId;
        uint256 total;
        for (uint256 i; i < count; ++i) {
            TaskInput calldata t = tasks[i];
            (uint256 taskId, uint256 deadline) =
                _recordTask(t.taskHash, token, t.amount, t.category, t.locationZone, t.duration, t.verifierAgent);
            total += t.amount;
            _announceTask(taskId, token, t.amount, t.taskHash, t.category, t.locationZone, deadline);
        }

        // Interactions last (CEI): one pull for the whole batch. A shortfall in
        // allowance or balance reverts every task above.
        IERC20(token).safeTransferFrom(msg.sender, address(this), total);
    }

    /**
     * @notice Creates an open-submission task: nobody is assigned. Anyone but
     *         the poster and the judges may submitOpen one result before the
     *         deadline, with no cap on how many, and one submitter wins the
     *         whole amount less the platform fee. After the effective
     *         deadline the judges take turns, each only in its own window:
     *           1. CreatorReview only: the poster (selectWinner), for
     *              `creatorWindow`;
     *           2. `verifierAgent` (selectWinnerByVerifier), for
     *              VERIFIER_PICK_WINDOW;
     *           3. the global verifier as backup judge (selectWinnerByBackup,
     *              or voidOpenTask when no submission is valid), for
     *              BACKUP_PICK_WINDOW;
     *           4. then the admin, with no time limit (resolveOpenTask).
     *         The poster cannot cancel once anything has been submitted.
     * @param verifierAgent The task verifier. Required, and not the poster.
     * @param mode AgentManaged (`creatorWindow` must be 0) or CreatorReview.
     * @param creatorWindow CreatorReview: seconds the poster has to pick,
     *        MIN_CREATOR_WINDOW (1 h) to MAX_CREATOR_WINDOW (7 d).
     */
    function createTaskOpen(
        bytes32 taskHash,
        address token,
        uint256 amount,
        string calldata category,
        string calldata locationZone,
        uint256 duration,
        address verifierAgent,
        PickMode mode,
        uint256 creatorWindow
    ) external payable nonReentrant whenNotPaused returns (uint256 taskId) {
        if (verifierAgent == address(0)) revert ZeroAddress();
        bool windowOk = mode == PickMode.CreatorReview
            ? creatorWindow >= MIN_CREATOR_WINDOW && creatorWindow <= MAX_CREATOR_WINDOW
            : creatorWindow == 0;
        if (!windowOk) revert InvalidPickWindow();

        uint256 deadline;
        (taskId, deadline) = _recordTask(taskHash, token, amount, category, locationZone, duration, verifierAgent);
        _openTasks[taskId] = OpenTask({open: true, mode: mode, creatorWindow: uint32(creatorWindow), closedBy: Judge.None});
        emit OpenTaskCreated(taskId, mode, creatorWindow);

        // Interactions last (CEI)
        _pullPayment(token, amount);

        _announceTask(taskId, token, amount, taskHash, category, locationZone, deadline);
    }

    function _createTask(
        bytes32 taskHash,
        address token,
        uint256 amount,
        string calldata category,
        string calldata locationZone,
        uint256 duration,
        address verifierAgent
    ) internal returns (uint256 taskId) {
        uint256 deadline;
        (taskId, deadline) = _recordTask(taskHash, token, amount, category, locationZone, duration, verifierAgent);

        // Interactions last (CEI)
        _pullPayment(token, amount);

        _announceTask(taskId, token, amount, taskHash, category, locationZone, deadline);
    }

    /// Takes one task's escrow from the caller: exactly `amount` of native
    /// value, or an ERC-20 transferFrom with no value sent.
    function _pullPayment(address token, uint256 amount) internal {
        if (token == address(0)) {
            if (msg.value != amount) revert ZeroAmount();
        } else {
            if (msg.value > 0) revert ZeroAmount();
            IERC20(token).safeTransferFrom(msg.sender, address(this), amount);
        }
    }

    /// Checks and effects of creating one task, shared by createTask,
    /// createTaskWithVerifier and createTasks: validates it and records it
    /// (task, pause accounting, per-task verifier). Moves no funds; the caller
    /// pulls them, then calls _announceTask.
    function _recordTask(
        bytes32 taskHash,
        address token,
        uint256 amount,
        string calldata category,
        string calldata locationZone,
        uint256 duration,
        address verifierAgent
    ) internal returns (uint256 taskId, uint256 deadline) {
        if (amount == 0) revert ZeroAmount();
        if (taskHash == bytes32(0)) revert EmptyHash();
        if (!allowedTokens[token]) revert TokenNotAllowed();
        if (duration < MIN_DEADLINE || duration > MAX_DEADLINE) revert InvalidDeadline();

        taskId = nextTaskId++;
        deadline = block.timestamp + duration;

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
            submissionAttempts: 0,
            disputedAt: 0
        });
        // Task creation is whenNotPaused, so pausedSince is 0 here and
        // pausedTotal is the whole paused time so far.
        _pausedTotalAtCreate[taskId] = pausedTotal;

        if (verifierAgent != address(0)) {
            // The poster cannot verify their own task.
            if (verifierAgent == msg.sender) revert SelfAssignment();
            taskVerifier[taskId] = verifierAgent;
            emit TaskVerifierSet(taskId, verifierAgent);
        }
    }

    /// The bookkeeping after a task is recorded: the optional TaskRegistry
    /// publish, then TaskCreated.
    function _announceTask(
        uint256 taskId,
        address token,
        uint256 amount,
        bytes32 taskHash,
        string calldata category,
        string calldata locationZone,
        uint256 deadline
    ) internal {
        // Publish to TaskRegistry if connected. Optional bookkeeping — a paused or
        // reverting registry must not block task creation.
        if (address(taskRegistry) != address(0)) {
            try taskRegistry.publishTask(taskId, msg.sender, category, locationZone, amount) {} catch {}
        }

        emit TaskCreated(taskId, msg.sender, token, amount, taskHash, category, locationZone, deadline);
    }

    function _transferPayout(address token, address to, uint256 amount) internal {
        if (amount == 0) return;
        if (token == address(0)) {
            (bool success, ) = to.call{value: amount}("");
            require(success, "native transfer failed");
        } else {
            IERC20(token).safeTransfer(to, amount);
        }
    }

    /// @dev Seconds the escrow has spent paused since this upgrade, the running
    ///      pause included (its start is known unless installed mid-pause).
    function _pausedSeconds() internal view returns (uint256 total) {
        total = pausedTotal;
        if (pausedSince != 0) total += block.timestamp - pausedSince;
    }

    /// @dev Seconds paused since `taskId` was created: how far its deadline and
    ///      windows move. Counting from creation can only lengthen a window
    ///      that opened later (a dispute or appeal window), never shorten it.
    function _pauseExtension(uint256 taskId) internal view returns (uint256) {
        return _pausedSeconds() - _pausedTotalAtCreate[taskId];
    }

    /// @dev The task's deadline moved by the time the escrow spent paused.
    function _deadline(uint256 taskId) internal view returns (uint256) {
        return _tasks[taskId].deadline + _pauseExtension(taskId);
    }

    /**
     * @dev Whether a passed verification earns the worker a BlindReputation
     *      rating. The poster picks every party to a completion (worker via
     *      assignWorker, verifier via createTaskWithVerifier) and distinct
     *      addresses cost nothing, so a rating must carry economic weight and
     *      come from a judge the poster did not choose:
     *        - the platform fee is non-zero (a completion that paid nothing
     *          proves nothing; below 10 units at 1000 bps the fee rounds to 0),
     *        - the amount meets the admin-set per-token minRatedAmount,
     *        - the judge was not chosen by the poster (`judgeChosenByPoster`
     *          false). For a single-worker task that means no per-task
     *          verifier. For an open task the poster chose both the creator
     *          and the task verifier, so only a winner picked by the backup
     *          judge (the global verifier) or the admin is rated.
     *      Settlement itself is unaffected; only the rating is withheld.
     */
    function _earnsRating(Task storage t, uint256 fee, bool judgeChosenByPoster) internal view returns (bool) {
        return fee > 0 && t.amount >= minRatedAmount[t.token] && !judgeChosenByPoster;
    }

    /// The platform's cut of `amount` at the current fee.
    function _platformFee(uint256 amount) internal view returns (uint256) {
        return (amount * feeBps) / 10_000;
    }

    /**
     * @dev Pays a task out in its worker's favour, the one payout path every
     *      settlement shares: the worker gets the amount less the platform fee
     *      and the treasury gets the fee, the task becomes Completed, and the
     *      worker is rated `score` when non-zero. Callers decide the score
     *      (with _earnsRating where it applies) and emit their own events,
     *      TaskCompleted last, so each keeps its log order.
     */
    function _payWorker(uint256 taskId, Task storage t, uint8 score) internal returns (uint256 payout, uint256 fee) {
        // ── Effects (all state changes first) ──
        fee = _platformFee(t.amount);
        payout = t.amount - fee;
        t.status = TaskStatus.Completed;

        // ── Interactions (external calls last) ──
        _transferPayout(t.token, t.worker, payout);
        _transferPayout(t.token, treasury, fee);

        // Record reputation if connected (optional — the worker is already
        // paid above; a reverting/paused reputation contract must not undo it).
        if (score != 0 && address(reputationContract) != address(0)) {
            try reputationContract.rate(t.worker, score, taskId) {} catch {}
        }
    }

    /// The score a passed verification gives: 5, when it earns a rating at all.
    function _passScore(uint256 taskId, Task storage t) internal view returns (uint8) {
        return _earnsRating(t, _platformFee(t.amount), taskVerifier[taskId] != address(0)) ? 5 : 0;
    }

    /**
     * @dev Verify that `signature` is a valid enclave signature over `signedText`.
     *      Uses OpenZeppelin's ECDSA, which rejects malleable (high-s) signatures
     *      and bad lengths instead of returning a junk address.
     */
    function _verifyTeeSignature(bytes calldata signature, bytes calldata signedText) internal view {
        if (teeSigner == address(0)) revert TEESignerNotSet();

        bytes32 digest = MessageHashUtils.toEthSignedMessageHash(signedText);
        (address recovered, ECDSA.RecoverError err, ) = ECDSA.tryRecoverCalldata(digest, signature);

        if (err != ECDSA.RecoverError.NoError || recovered != teeSigner) {
            revert InvalidTEESignature();
        }
    }

    /// Close the task's TaskRegistry listing, if a registry is connected
    /// (optional — must not block the caller).
    function _closeListing(uint256 taskId) internal {
        if (address(taskRegistry) != address(0)) {
            try taskRegistry.closeTask(taskId) {} catch {}
        }
    }

    /**
     * @notice Agent assigns a worker to the task. Only possible while Funded and before deadline.
     *         Never for an open task: a judge picks its winner from the submissions.
     * @dev Agent cannot assign themselves to prevent self-dealing.
     */
    function assignWorker(uint256 taskId, address worker) external onlyAgent(taskId) whenNotPaused {
        if (_openTasks[taskId].open) revert OpenTaskUnsupported();
        Task storage t = _tasks[taskId];
        if (t.status != TaskStatus.Funded) revert InvalidStatus(t.status, TaskStatus.Funded);
        if (worker == address(0)) revert ZeroAddress();
        if (worker == msg.sender) revert SelfAssignment();
        if (block.timestamp >= _deadline(taskId)) revert DeadlineReached();

        t.worker = worker;
        t.status = TaskStatus.Assigned;

        _closeListing(taskId);

        emit WorkerAssigned(taskId, worker);
    }

    /**
     * @notice Marketplace verifier assigns a worker on the task agent's behalf.
     * @dev Enables autonomous A2A settlement: when an off-chain A2A executor accepts a
     *      task, the marketplace backend (set via setVerifier) calls this so the poster
     *      doesn't need to sign assignWorker themselves. Self-deal protection is enforced
     *      against the task's actual agent (t.agent), not msg.sender (the verifier, who
     *      should never be assignable as the worker either, but that's an off-chain
     *      concern). Never for an open task, like assignWorker.
     */
    function marketplaceAssign(uint256 taskId, address worker) external onlyVerifier whenNotPaused {
        if (_openTasks[taskId].open) revert OpenTaskUnsupported();
        Task storage t = _tasks[taskId];
        if (t.status != TaskStatus.Funded) revert InvalidStatus(t.status, TaskStatus.Funded);
        if (worker == address(0)) revert ZeroAddress();
        if (worker == t.agent) revert SelfAssignment();
        if (block.timestamp >= _deadline(taskId)) revert DeadlineReached();

        t.worker = worker;
        t.status = TaskStatus.Assigned;

        // Same downstream effect as assignWorker.
        _closeListing(taskId);

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
        if (block.timestamp >= _deadline(taskId)) revert DeadlineReached();

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
    function completeVerification(uint256 taskId, bool passed) external nonReentrant whenNotPaused {
        Task storage t = _tasks[taskId];
        // A per-task verifier (verificationMode='agent') settles its own task
        // trustlessly; tasks with no per-task verifier (auto/manual, and every
        // task created before this upgrade) fall back to the global verifier
        // (the marketplace relay). Either way the verifier can never be the
        // worker who did the job.
        address taskV = taskVerifier[taskId];
        if (taskV != address(0)) {
            if (msg.sender != taskV) revert NotVerifier();
        } else {
            if (msg.sender != verifier) revert NotVerifier();
        }
        if (msg.sender == t.worker) revert NotVerifier();
        if (t.status != TaskStatus.Submitted) revert InvalidStatus(t.status, TaskStatus.Submitted);

        emit VerificationCompleted(taskId, passed);

        if (passed) {
            // Rated only for a completion that can't be self-dealt for free.
            (uint256 payout, uint256 fee) = _payWorker(taskId, t, _passScore(taskId, t));
            emit TaskCompleted(taskId, payout, fee);
        } else {
            // Failed verification — worker can retry if attempts remain, or
            // appeal with raiseDispute within APPEAL_WINDOW.
            t.status = TaskStatus.Verified;
            failedVerdictAt[taskId] = block.timestamp;

            // Record dispute if max attempts reached (optional bookkeeping)
            if (t.submissionAttempts >= MAX_SUBMISSION_ATTEMPTS && address(reputationContract) != address(0)) {
                try reputationContract.recordDispute(t.worker, taskId) {} catch {}
            }
        }
    }

    /**
     * @notice Settlement that additionally records a 0G TEE attestation on-chain.
     *
     * @dev Authorization is identical to {completeVerification} and is NOT
     *      delegated to the signature. The 0G TEE signs a commitment over an
     *      inference request/response pair — it carries no binding to `taskId`,
     *      to `passed`, or to this contract, and the same enclave key signs for
     *      every customer of that provider. Treating such a signature as an
     *      authorization token would let anyone holding any enclave signature
     *      settle any submitted task; the attestation is therefore an
     *      *additional* requirement layered on top of the verifier gate, never
     *      a replacement for it.
     *
     *      Making this path genuinely trustless requires an enclave that signs
     *      over (chainId, address(this), taskId, passed, evidenceHash). Until
     *      the 0G TEE can produce that commitment, the verifier gate stands.
     *
     * @param taskId On-chain task ID
     * @param passed Whether verification passed
     * @param signature ECDSA signature from the 0G TEE (65 bytes: r + s + v)
     * @param signedText The exact text the TEE signed via personal_sign
     */
    function completeVerificationWithTEE(
        uint256 taskId,
        bool passed,
        bytes calldata signature,
        bytes calldata signedText
    ) external nonReentrant whenNotPaused {
        Task storage t = _tasks[taskId];

        // Same gate as completeVerification: a per-task verifier settles its own
        // task, everything else falls back to the global marketplace verifier,
        // and the worker can never settle the job it was paid for.
        address taskV = taskVerifier[taskId];
        if (taskV != address(0)) {
            if (msg.sender != taskV) revert NotVerifier();
        } else {
            if (msg.sender != verifier) revert NotVerifier();
        }
        if (msg.sender == t.worker) revert NotVerifier();

        if (t.status != TaskStatus.Submitted) revert InvalidStatus(t.status, TaskStatus.Submitted);

        _verifyTeeSignature(signature, signedText);

        emit VerificationCompleted(taskId, passed);
        emit TEESettled(taskId, passed, teeSigner);

        if (passed) {
            (uint256 payout, uint256 fee) = _payWorker(taskId, t, _passScore(taskId, t));
            emit TaskCompleted(taskId, payout, fee);
        } else {
            t.status = TaskStatus.Verified;
            failedVerdictAt[taskId] = block.timestamp;

            if (t.submissionAttempts >= MAX_SUBMISSION_ATTEMPTS && address(reputationContract) != address(0)) {
                try reputationContract.recordDispute(t.worker, taskId) {} catch {}
            }
        }
    }

    /**
     * @notice Agent cancels task. Only possible while Funded (before worker assigned),
     *         and for an open task only while nothing has been submitted: the
     *         poster cannot take the escrow back from under its submitters.
     */
    function cancelTask(uint256 taskId) external onlyAgent(taskId) nonReentrant whenNotPaused {
        Task storage t = _tasks[taskId];
        if (t.status != TaskStatus.Funded) revert InvalidStatus(t.status, TaskStatus.Funded);
        // Only an open task has submissions.
        if (submissionCount[taskId] != 0) revert HasSubmissions();

        // Effects
        t.status = TaskStatus.Cancelled;

        // Interactions
        _transferPayout(t.token, t.agent, t.amount);

        _closeListing(taskId);

        emit TaskCancelled(taskId, t.amount);
    }

    /**
     * @notice Poster's recovery once the deadline has passed.
     *         - Assigned (never delivered): full refund to the poster. Prevents
     *           funds from being locked forever if the worker ghosts.
     *         - Submitted (delivered before the deadline, never judged): NOT a
     *           refund. The task is escalated to Disputed for the admin's
     *           resolveDispute; if no ruling comes within DISPUTE_WINDOW the
     *           worker can collect it with releaseUnjudgedWork. A verdict that
     *           never arrives must not count as a refund to the poster, who in
     *           manual mode (or through a per-task verifier it controls) holds
     *           that verdict.
     *         - Verified (failed): refund, once the worker's APPEAL_WINDOW after
     *           the latest fail verdict has passed.
     *         - Disputed: refund once DISPUTE_WINDOW has elapsed since the
     *           dispute was raised, except for an escalation of unjudged work,
     *           which never falls back to the poster.
     *         Pause-neutral: it is whenNotPaused like every other non-admin
     *         transition that moves funds, and the deadline and windows are
     *         measured with the time spent paused added (see effectiveDeadline).
     */
    function claimTimeout(uint256 taskId) external onlyAgent(taskId) nonReentrant whenNotPaused {
        Task storage t = _tasks[taskId];
        if (block.timestamp < _deadline(taskId)) revert DeadlineNotReached();

        if (t.status == TaskStatus.Submitted) {
            // Delivered on time and never judged: adjudicate, never refund by
            // default. No funds move here.
            t.status = TaskStatus.Disputed;
            t.disputedAt = block.timestamp;
            unjudgedEscalation[taskId] = true;
            emit UnjudgedWorkEscalated(taskId);
            emit TaskDisputed(taskId, msg.sender);
            return;
        }

        if (t.status == TaskStatus.Disputed) {
            // Escalated unjudged work settles only through resolveDispute or
            // the worker's releaseUnjudgedWork, never back to the poster.
            if (unjudgedEscalation[taskId]) revert EscalatedForAdjudication();

            // A stale dispute must not freeze escrow forever if the admin key
            // is ever lost or unavailable. Once DISPUTE_WINDOW has elapsed
            // since raiseDispute, the poster's timeout refund becomes
            // available again, same as any other unresolved task.
            //
            // The disputedAt != 0 guard matters: tasks disputed BEFORE this
            // upgrade never had disputedAt set, so it reads 0 for them. Without
            // this guard, `0 + DISPUTE_WINDOW` is long past, making every
            // pre-existing dispute instantly claimable the moment the upgrade
            // lands. Those must keep requiring admin resolution via
            // resolveDispute — so windowElapsed is false whenever disputedAt
            // is still 0, not just when the window hasn't yet run.
            bool windowElapsed = t.disputedAt != 0 &&
                block.timestamp >= t.disputedAt + DISPUTE_WINDOW + _pauseExtension(taskId);
            if (!windowElapsed) revert DisputeWindowActive();
        } else if (t.status == TaskStatus.Verified) {
            // A failed verdict: the worker keeps APPEAL_WINDOW to raiseDispute,
            // even past the deadline. failedVerdictAt is 0 for tasks failed
            // before this upgrade, so their window reads as long elapsed.
            if (block.timestamp < failedVerdictAt[taskId] + APPEAL_WINDOW + _pauseExtension(taskId)) {
                revert AppealWindowActive();
            }
        } else if (t.status != TaskStatus.Assigned) {
            revert InvalidStatus(t.status, TaskStatus.Assigned);
        }

        // Effects
        t.status = TaskStatus.Cancelled;

        // Interactions
        _transferPayout(t.token, t.agent, t.amount);

        emit DeadlineExpired(taskId, t.amount);
    }

    /**
     * @notice Agent or worker can raise a dispute. Moves task to Disputed status.
     *         Disputes are resolved by admin via resolveDispute(). Before the
     *         deadline either party can; after it, only the worker can, to
     *         appeal a failed verdict within APPEAL_WINDOW of it.
     */
    function raiseDispute(uint256 taskId) external whenNotPaused {
        Task storage t = _tasks[taskId];
        bool isSender = msg.sender == t.agent || msg.sender == t.worker;
        require(isSender, "not party to task");

        // Can dispute during Submitted or Verified (failed)
        bool canDispute = t.status == TaskStatus.Submitted || t.status == TaskStatus.Verified;
        if (!canDispute) revert InvalidStatus(t.status, TaskStatus.Submitted);

        // After the deadline a party must not be able to raise a NEW dispute
        // purely to freeze the escrow and delay the poster's claimTimeout — a
        // griefing / fund-lock vector. The one exception is the worker's appeal
        // of a failed verdict within APPEAL_WINDOW of it: without it, a fail
        // verdict landing near (or after) the deadline would hand the escrow to
        // the poster with no review. The appeal is bounded — the resulting
        // dispute falls back to claimTimeout after DISPUTE_WINDOW like any
        // other.
        uint256 ext = _pauseExtension(taskId);
        bool workerAppeal = msg.sender == t.worker &&
            t.status == TaskStatus.Verified &&
            block.timestamp < failedVerdictAt[taskId] + APPEAL_WINDOW + ext;
        if (block.timestamp >= t.deadline + ext && !workerAppeal) revert DeadlineReached();

        t.status = TaskStatus.Disputed;
        t.disputedAt = block.timestamp;
        emit TaskDisputed(taskId, msg.sender);
    }

    /**
     * @notice Admin resolves a dispute. If workerFavored, pays worker. Otherwise refunds agent.
     *         Deliberately NOT pause-gated: the admin can still settle disputes
     *         while the escrow is paused.
     */
    function resolveDispute(uint256 taskId, bool workerFavored) external onlyAdmin nonReentrant {
        Task storage t = _tasks[taskId];
        if (t.status != TaskStatus.Disputed) revert InvalidStatus(t.status, TaskStatus.Disputed);

        if (workerFavored) {
            // Neutral score for a disputed completion.
            (uint256 payout, uint256 fee) = _payWorker(taskId, t, 3);

            emit DisputeResolved(taskId, true);
            emit TaskCompleted(taskId, payout, fee);
        } else {
            t.status = TaskStatus.Cancelled;

            _transferPayout(t.token, t.agent, t.amount);

            if (address(reputationContract) != address(0)) {
                // optional bookkeeping — the agent is already refunded above
                try reputationContract.recordDispute(t.worker, taskId) {} catch {}
            }

            emit DisputeResolved(taskId, false);
            emit TaskCancelled(taskId, t.amount);
        }
    }

    /**
     * @notice The worker collects the escrow of delivered work that was never
     *         judged, once claimTimeout escalated it and DISPUTE_WINDOW has
     *         passed without an admin ruling. Pays the usual worker/fee split.
     * @dev Keeps these funds recoverable if the admin key is unavailable. The
     *      default here is the worker, not the poster (unlike a dispute raised
     *      over a verdict): the work arrived before the deadline and the party
     *      that should have judged it never did. No reputation is recorded,
     *      since nobody judged the work.
     */
    function releaseUnjudgedWork(uint256 taskId) external onlyWorker(taskId) nonReentrant whenNotPaused {
        Task storage t = _tasks[taskId];
        if (t.status != TaskStatus.Disputed) revert InvalidStatus(t.status, TaskStatus.Disputed);
        if (!unjudgedEscalation[taskId]) revert NotEscalated();
        if (block.timestamp < t.disputedAt + DISPUTE_WINDOW + _pauseExtension(taskId)) revert DisputeWindowActive();

        // No rating: nobody judged the work.
        (uint256 payout, uint256 fee) = _payWorker(taskId, t, 0);

        emit UnjudgedWorkReleased(taskId, payout, fee);
        emit TaskCompleted(taskId, payout, fee);
    }

    // ── Open submission ──
    //
    // An open task's status only ever goes Funded -> Completed (a winner is
    // paid) or Funded -> Cancelled (refunded). assignWorker and
    // marketplaceAssign refuse it, so it has no worker until its pick and is
    // never Assigned, Submitted, Verified or Disputed. That makes the
    // single-worker lifecycle unreachable for it: submitEvidence and
    // releaseUnjudgedWork revert NotWorker (no worker to match) or
    // InvalidStatus, and completeVerification, completeVerificationWithTEE,
    // claimTimeout, raiseDispute and resolveDispute revert InvalidStatus.
    // cancelTask works only while nothing has been submitted.

    /**
     * @notice Submit a result to an open task: the evidence hash, committed
     *         and final. One per address, before the effective deadline. The
     *         poster, the task verifier and the global verifier judge the
     *         task, so they cannot submit.
     */
    function submitOpen(uint256 taskId, bytes32 evidenceHash) external whenNotPaused {
        if (!_openTasks[taskId].open) revert NotOpenTask();
        Task storage t = _tasks[taskId];
        if (t.status != TaskStatus.Funded) revert InvalidStatus(t.status, TaskStatus.Funded);
        if (msg.sender == t.agent || msg.sender == taskVerifier[taskId] || msg.sender == verifier) revert SelfAssignment();
        if (evidenceHash == bytes32(0)) revert EmptyHash();
        if (block.timestamp >= _deadline(taskId)) revert DeadlineReached();
        if (submissionOf[taskId][msg.sender] != bytes32(0)) revert AlreadySubmitted();

        submissionOf[taskId][msg.sender] = evidenceHash;
        uint256 count = submissionCount[taskId] + 1;
        submissionCount[taskId] = count;

        emit OpenSubmission(taskId, msg.sender, evidenceHash, count);
    }

    /// @notice The poster picks the winner of a CreatorReview task, in its creator window.
    function selectWinner(uint256 taskId, address winner, bytes32 scorecardHash) external nonReentrant whenNotPaused {
        if (msg.sender != _tasks[taskId].agent) revert NotAgent();
        _requirePhase(taskId, OpenPhase.CreatorPick);
        _selectWinner(taskId, winner, scorecardHash, Judge.Creator);
    }

    /// @notice The task verifier picks the winner, in its window.
    function selectWinnerByVerifier(uint256 taskId, address winner, bytes32 scorecardHash) external nonReentrant whenNotPaused {
        if (msg.sender != taskVerifier[taskId]) revert NotVerifier();
        _requirePhase(taskId, OpenPhase.VerifierPick);
        _selectWinner(taskId, winner, scorecardHash, Judge.TaskVerifier);
    }

    /// @notice The global verifier, as backup judge, picks the winner in its window.
    function selectWinnerByBackup(uint256 taskId, address winner, bytes32 scorecardHash) external onlyVerifier nonReentrant whenNotPaused {
        _requirePhase(taskId, OpenPhase.BackupPick);
        _selectWinner(taskId, winner, scorecardHash, Judge.Backup);
    }

    /**
     * @notice Refund an open task to its poster in full.
     *         - Nothing submitted: the poster, once the deadline has passed
     *           (before it, cancelTask does the same).
     *         - Something submitted: only the global verifier, in its backup
     *           window, when it finds no valid submission. The poster and the
     *           task verifier the poster chose cannot void submitted work:
     *           that would let a poster read every result and pay nothing.
     *           After the backup window the admin voids with resolveOpenTask.
     * @param scorecardHash Hash of the judge's scorecard; 0 when there is none.
     */
    function voidOpenTask(uint256 taskId, bytes32 scorecardHash) external nonReentrant whenNotPaused {
        OpenPhase phase = _openPhase(taskId);
        Judge judge;
        if (submissionCount[taskId] == 0) {
            if (msg.sender != _tasks[taskId].agent) revert NotAgent();
            if (phase == OpenPhase.Submissions || phase == OpenPhase.Closed) revert WrongPhase(phase);
            judge = Judge.Creator;
        } else {
            if (msg.sender != verifier) revert NotVerifier();
            if (phase != OpenPhase.BackupPick) revert WrongPhase(phase);
            judge = Judge.Backup;
        }
        _voidOpenTask(taskId, judge, scorecardHash);
    }

    /**
     * @notice The admin settles an open task nobody else settled, once the
     *         backup window has closed: pays `winner`, or refunds the poster
     *         in full when `winner` is address(0). No time limit, so an open
     *         task's escrow always has a way out. Like resolveDispute, not
     *         pause-gated.
     */
    function resolveOpenTask(uint256 taskId, address winner, bytes32 scorecardHash) external onlyAdmin nonReentrant {
        _requirePhase(taskId, OpenPhase.AdminResolve);
        if (winner == address(0)) _voidOpenTask(taskId, Judge.Admin, scorecardHash);
        else _selectWinner(taskId, winner, scorecardHash, Judge.Admin);
    }

    /// @dev The phase an open task is in now. Every window follows the
    ///      effective deadline, so a pause moves them all by the time paused.
    function _openPhase(uint256 taskId) internal view returns (OpenPhase) {
        OpenTask storage o = _openTasks[taskId];
        if (!o.open) revert NotOpenTask();
        if (_tasks[taskId].status != TaskStatus.Funded) return OpenPhase.Closed;
        uint256 end = _deadline(taskId);
        if (block.timestamp < end) return OpenPhase.Submissions;
        end += o.creatorWindow;
        if (block.timestamp < end) return OpenPhase.CreatorPick;
        end += VERIFIER_PICK_WINDOW;
        if (block.timestamp < end) return OpenPhase.VerifierPick;
        end += BACKUP_PICK_WINDOW;
        if (block.timestamp < end) return OpenPhase.BackupPick;
        return OpenPhase.AdminResolve;
    }

    function _requirePhase(uint256 taskId, OpenPhase phase) internal view {
        OpenPhase current = _openPhase(taskId);
        if (current != phase) revert WrongPhase(current);
    }

    /**
     * @dev Pays `winner` the amount less the fee, exactly as a passed
     *      verification pays a worker; its submission becomes the task's
     *      worker and evidence. Rated only when the judge was not the
     *      poster's choice: the backup judge or the admin (_earnsRating).
     */
    function _selectWinner(uint256 taskId, address winner, bytes32 scorecardHash, Judge judge) internal {
        Task storage t = _tasks[taskId];
        bytes32 evidence = submissionOf[taskId][winner];
        if (evidence == bytes32(0)) revert NoSubmission();
        // No judge pays itself, e.g. an address that submitted and later became the global verifier.
        if (winner == msg.sender) revert SelfAssignment();

        // ── Effects ──
        t.worker = winner;
        t.evidenceHash = evidence;
        _openTasks[taskId].closedBy = judge;
        scorecardOf[taskId] = scorecardHash;
        emit WinnerSelected(taskId, winner, judge, scorecardHash);

        // ── Interactions ──
        bool chosenByPoster = judge == Judge.Creator || judge == Judge.TaskVerifier;
        uint8 score = _earnsRating(t, _platformFee(t.amount), chosenByPoster) ? 5 : 0;
        (uint256 payout, uint256 fee) = _payWorker(taskId, t, score);
        _closeListing(taskId);
        emit TaskCompleted(taskId, payout, fee);
    }

    /// @dev Refunds an open task to its poster in full.
    function _voidOpenTask(uint256 taskId, Judge judge, bytes32 scorecardHash) internal {
        Task storage t = _tasks[taskId];

        // ── Effects ──
        t.status = TaskStatus.Cancelled;
        _openTasks[taskId].closedBy = judge;
        scorecardOf[taskId] = scorecardHash;
        emit OpenTaskVoided(taskId, judge, scorecardHash);

        // ── Interactions ──
        _transferPayout(t.token, t.agent, t.amount);
        _closeListing(taskId);
        emit TaskCancelled(taskId, t.amount);
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

    /// @notice Set the minimum task amount, in `token` units, for a passed
    ///         verification to earn a reputation rating. 0 leaves only the
    ///         non-zero-fee requirement.
    function setMinRatedAmount(address token, uint256 amount) external onlyAdmin {
        emit MinRatedAmountUpdated(token, minRatedAmount[token], amount);
        minRatedAmount[token] = amount;
    }

    function setTeeSigner(address _teeSigner) external onlyAdmin {
        emit TeeSignerUpdated(teeSigner, _teeSigner);
        teeSigner = _teeSigner;
    }

    function setFeeBps(uint256 _feeBps) external onlyAdmin {
        if (_feeBps > MAX_FEE_BPS) revert FeeExceedsMax();
        emit FeeBpsUpdated(feeBps, _feeBps);
        feeBps = _feeBps;
    }

    function allowToken(address token) external onlyAdmin {
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
        pausedSince = block.timestamp;
    }

    function unpause() external onlyAdmin {
        _unpause();
        // pausedSince is 0 here only if this implementation was installed
        // during a pause and recordPauseStart was not called: that pause's
        // start is unknown, so it is not counted. Never add
        // `block.timestamp - 0`, which would push every in-flight deadline out
        // by decades and lock ghosted-worker refunds.
        if (pausedSince != 0) pausedTotal += block.timestamp - pausedSince;
        pausedSince = 0;
    }

    /**
     * @notice Upgrade-time repair. When this implementation is installed while
     *         the escrow is paused (the documented emergency path), the running
     *         pause's start is unknown and unpause would not count it. Before
     *         unpausing, the admin records it: pass the block timestamp of the
     *         Paused event. Only while paused, only when the start is unknown.
     */
    function recordPauseStart(uint256 pausedAt) external onlyAdmin whenPaused {
        if (pausedSince != 0 || pausedAt == 0 || pausedAt > block.timestamp) revert InvalidPauseStart();
        pausedSince = pausedAt;
        emit PauseStartRecorded(pausedAt);
    }

    // ── View Functions ──

    function getTask(uint256 taskId) external view returns (Task memory) {
        return _tasks[taskId];
    }

    /// @notice The task's deadline moved by the time the escrow has spent paused
    ///         since it was created (a running pause included). getTask().deadline
    ///         is the unmoved creation-time value; deadline checks use this one.
    function effectiveDeadline(uint256 taskId) external view returns (uint256) {
        return _deadline(taskId);
    }

    function isTaskExpired(uint256 taskId) external view returns (bool) {
        return block.timestamp >= _deadline(taskId);
    }

    /// @notice An open task's settings and outcome. `open` is false for every other task.
    function getOpenTask(uint256 taskId) external view returns (OpenTask memory) {
        return _openTasks[taskId];
    }

    /// @notice The phase an open task is in now, pause-adjusted like
    ///         effectiveDeadline. Reverts NotOpenTask for any other task.
    function openPhase(uint256 taskId) external view returns (OpenPhase) {
        return _openPhase(taskId);
    }
}
