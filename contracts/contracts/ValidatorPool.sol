// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/**
 * @title ValidatorPool
 * @notice Hybrid dispute resolution for BlindMarket.
 *         TEE handles routine verifications. Validators vote on disputes.
 *
 * Flow:
 *   1. Validators stake tokens to join the pool.
 *   2. BlindEscrow calls openDispute() when raiseDispute() is triggered.
 *   3. Active validators vote within VOTE_WINDOW.
 *   4. Anyone calls finalizeDispute() after window closes.
 *   5. Majority wins. Correct voters share reward. Wrong voters slashed.
 *   6. BlindEscrow.resolveDispute() is called with the result.
 */
contract ValidatorPool is ReentrancyGuard {
    using SafeERC20 for IERC20;

    // ── Constants ──

    uint256 public constant MIN_STAKE        = 100e6;   // 100 USDC (6 decimals) minimum stake
    uint256 public constant VOTE_WINDOW      = 48 hours;
    uint256 public constant SLASH_BPS        = 1000;    // 10% slashed from wrong voters
    uint256 public constant REWARD_BPS       = 500;     // 5% of dispute amount to correct voters
    uint256 public constant MIN_VOTES        = 3;       // minimum votes to be valid
    uint256 public constant MAX_VOTERS       = 64;      // cap per dispute so finalizeDispute's
                                                        // voter loops can never exceed block gas
                                                        // (a stuck finalize would freeze stakes)

    // ── Types ──

    enum Vote { None, Worker, Agent }

    struct Validator {
        uint256 stake;
        bool    active;
        uint256 totalVotes;
        uint256 correctVotes;
    }

    struct Dispute {
        uint256 taskId;
        address escrow;         // BlindEscrow that opened this dispute
        address token;          // payment token (for reward distribution)
        uint256 amount;         // escrowed task amount
        uint256 openedAt;
        bool    finalized;
        bool    workerFavored;  // result
        uint256 workerVotes;
        uint256 agentVotes;
        mapping(address => Vote) votes;
        address[] voters;
    }

    // ── State ──

    IERC20  public immutable stakeToken;
    address public admin;

    mapping(address => Validator) public validators;
    address[] public validatorList;

    uint256 public nextDisputeId = 1;
    mapping(uint256 => Dispute) public disputes;
    // taskId → disputeId
    mapping(uint256 => uint256) public taskDispute;

    // Escrows the admin has allow-listed to open disputes. Without this,
    // openDispute() is permissionless and anyone can spam bogus disputes.
    mapping(address => bool) public authorizedEscrows;

    // Count of not-yet-finalized disputes a validator has voted in. A validator
    // cannot unstake while this is nonzero, so they can't withdraw their stake to
    // dodge slashing after seeing which way a vote is going.
    mapping(address => uint256) public lockedInDisputes;

    // ── Events ──

    event ValidatorRegistered(address indexed validator, uint256 stake);
    event ValidatorUnstaked(address indexed validator, uint256 amount);
    event DisputeOpened(uint256 indexed disputeId, uint256 indexed taskId, address escrow);
    event Voted(uint256 indexed disputeId, address indexed validator, Vote vote);
    event DisputeFinalized(uint256 indexed disputeId, bool workerFavored, uint256 workerVotes, uint256 agentVotes);
    event RewardPaid(address indexed validator, uint256 amount);
    event Slashed(address indexed validator, uint256 amount);
    event EscrowAuthorized(address indexed escrow, bool allowed);
    event EscrowCallbackFailed(uint256 indexed disputeId, address escrow);

    // ── Errors ──

    error NotAdmin();
    error AlreadyValidator();
    error NotValidator();
    error InsufficientStake();
    error DisputeNotFound();
    error VoteWindowClosed();
    error VoteWindowOpen();
    error AlreadyVoted();
    error AlreadyFinalized();
    error NotEnoughVotes();
    error OnlyEscrow();
    error StakeLocked();
    error TooManyVoters();

    // ── Constructor ──

    constructor(address _stakeToken) {
        stakeToken = IERC20(_stakeToken);
        admin = msg.sender;
    }

    // ── Validator Registration ──

    function register(uint256 amount) external nonReentrant {
        if (validators[msg.sender].active) revert AlreadyValidator();
        if (amount < MIN_STAKE) revert InsufficientStake();

        stakeToken.safeTransferFrom(msg.sender, address(this), amount);

        validators[msg.sender] = Validator({ stake: amount, active: true, totalVotes: 0, correctVotes: 0 });
        validatorList.push(msg.sender);

        emit ValidatorRegistered(msg.sender, amount);
    }

    function unstake() external nonReentrant {
        Validator storage v = validators[msg.sender];
        if (!v.active) revert NotValidator();
        // Can't withdraw while a dispute you voted in is still open — otherwise a
        // validator watches the tally and unstakes before finalizeDispute() to
        // escape slashing (finalize slashes against current stake, which is 0).
        if (lockedInDisputes[msg.sender] != 0) revert StakeLocked();

        uint256 amount = v.stake;
        v.stake = 0;
        v.active = false;

        stakeToken.safeTransfer(msg.sender, amount);
        emit ValidatorUnstaked(msg.sender, amount);
    }

    // ── Dispute Lifecycle ──

    /// @notice Admin allow-lists (or removes) an escrow permitted to open disputes.
    /// @dev Admin MUST allow-list only a real BlindEscrow *contract*. Authorizing
    ///      an EOA would make finalizeDispute's callback revert outside the
    ///      try/catch (the extcodesize existence check runs in the caller frame)
    ///      and re-freeze voter stakes — an operator-error residual, not guarded
    ///      on-chain to keep the setter minimal.
    function setAuthorizedEscrow(address escrow, bool allowed) external {
        if (msg.sender != admin) revert NotAdmin();
        authorizedEscrows[escrow] = allowed;
        emit EscrowAuthorized(escrow, allowed);
    }

    /**
     * @notice Called by an allow-listed BlindEscrow when a dispute is raised.
     * @param taskId  The disputed task ID.
     * @param token   The payment token (used for reward distribution).
     * @param amount  The escrowed amount.
     */
    function openDispute(uint256 taskId, address token, uint256 amount) external returns (uint256 disputeId) {
        // Only an allow-listed BlindEscrow may open disputes. The declared
        // OnlyEscrow error was previously unused, leaving this permissionless.
        if (!authorizedEscrows[msg.sender]) revert OnlyEscrow();
        disputeId = nextDisputeId++;
        Dispute storage d = disputes[disputeId];
        d.taskId    = taskId;
        d.escrow    = msg.sender;
        d.token     = token;
        d.amount    = amount;
        d.openedAt  = block.timestamp;
        taskDispute[taskId] = disputeId;

        emit DisputeOpened(disputeId, taskId, msg.sender);
    }

    /**
     * @notice Active validator casts a vote.
     * @param disputeId  The dispute to vote on.
     * @param voteFor    Vote.Worker = worker wins, Vote.Agent = agent wins (refund).
     */
    function vote(uint256 disputeId, Vote voteFor) external {
        Dispute storage d = disputes[disputeId];
        if (d.openedAt == 0) revert DisputeNotFound();
        if (d.finalized) revert AlreadyFinalized();
        if (block.timestamp > d.openedAt + VOTE_WINDOW) revert VoteWindowClosed();
        if (!validators[msg.sender].active) revert NotValidator();
        if (d.votes[msg.sender] != Vote.None) revert AlreadyVoted();
        // Bound the panel so finalizeDispute's O(voters) loops always fit in a
        // block — otherwise a flood of sybil voters could make finalize
        // permanently un-callable and freeze every voter's locked stake.
        if (d.voters.length >= MAX_VOTERS) revert TooManyVoters();

        d.votes[msg.sender] = voteFor;
        d.voters.push(msg.sender);
        // Lock this validator's stake until the dispute is finalized.
        lockedInDisputes[msg.sender]++;

        if (voteFor == Vote.Worker) d.workerVotes++;
        else d.agentVotes++;

        emit Voted(disputeId, msg.sender, voteFor);
    }

    /**
     * @notice Finalize dispute after vote window closes.
     *         Distributes rewards to correct voters, slashes wrong voters.
     *         Calls back into BlindEscrow to release/refund funds.
     */
    function finalizeDispute(uint256 disputeId) external nonReentrant {
        Dispute storage d = disputes[disputeId];
        if (d.openedAt == 0) revert DisputeNotFound();
        if (d.finalized) revert AlreadyFinalized();
        if (block.timestamp <= d.openedAt + VOTE_WINDOW) revert VoteWindowOpen();

        // Mark finalized up front (CEI: no external call happens before this).
        d.finalized = true;

        uint256 totalVotes = d.workerVotes + d.agentVotes;
        if (totalVotes < MIN_VOTES) {
            // Not enough participation — admin resolves manually. Release every
            // voter's stake lock; no slashing occurs.
            for (uint256 i = 0; i < d.voters.length; i++) {
                lockedInDisputes[d.voters[i]]--;
            }
            emit DisputeFinalized(disputeId, false, d.workerVotes, d.agentVotes);
            return;
        }

        bool workerFavored = d.workerVotes >= d.agentVotes;
        d.workerFavored = workerFavored;
        Vote winningVote = workerFavored ? Vote.Worker : Vote.Agent;

        // Collect slash amounts from wrong voters. Their stake is guaranteed
        // intact: unstake() is blocked while lockedInDisputes > 0, so a voter can
        // never withdraw between voting and finalization to dodge the slash.
        uint256 slashPool = 0;
        for (uint256 i = 0; i < d.voters.length; i++) {
            address v = d.voters[i];
            if (d.votes[v] != winningVote) {
                uint256 slash = (validators[v].stake * SLASH_BPS) / 10_000;
                validators[v].stake -= slash;
                slashPool += slash;
                emit Slashed(v, slash);
            }
        }

        uint256 correctCount = workerFavored ? d.workerVotes : d.agentVotes;
        uint256 rewardEach = (correctCount > 0 && slashPool > 0) ? slashPool / correctCount : 0;

        // Reward correct voters, tally participation, and release EVERY voter's
        // stake lock. This loop must run for all voters regardless of the reward
        // split — otherwise locks would leak and those stakes freeze forever.
        for (uint256 i = 0; i < d.voters.length; i++) {
            address v = d.voters[i];
            if (d.votes[v] == winningVote) {
                if (rewardEach > 0) {
                    validators[v].stake += rewardEach;
                    emit RewardPaid(v, rewardEach);
                }
                validators[v].correctVotes++;
            }
            validators[v].totalVotes++;
            lockedInDisputes[v]--;
        }

        // Callback to BlindEscrow. WRAPPED: every pool-side effect above (slashing,
        // rewards, lock release, d.finalized) is already committed under CEI, so a
        // reverting escrow must NOT revert finalize — otherwise the lock releases
        // roll back and all voters' stakes freeze forever. (Notably resolveDispute
        // is onlyAdmin: the pool cannot call it until an admin/role wiring exists,
        // so it WOULD revert today.) Surface the failure for manual resolution.
        try IBlindEscrowDispute(d.escrow).resolveDispute(d.taskId, workerFavored) {}
        catch { emit EscrowCallbackFailed(disputeId, d.escrow); }

        emit DisputeFinalized(disputeId, workerFavored, d.workerVotes, d.agentVotes);
    }

    // ── View ──

    function getDispute(uint256 disputeId) external view returns (
        uint256 taskId, address escrow, uint256 amount, uint256 openedAt,
        bool finalized, bool workerFavored, uint256 workerVotes, uint256 agentVotes
    ) {
        Dispute storage d = disputes[disputeId];
        return (d.taskId, d.escrow, d.amount, d.openedAt, d.finalized, d.workerFavored, d.workerVotes, d.agentVotes);
    }

    function getVote(uint256 disputeId, address validator) external view returns (Vote) {
        return disputes[disputeId].votes[validator];
    }

    function activeValidatorCount() external view returns (uint256 count) {
        for (uint256 i = 0; i < validatorList.length; i++) {
            if (validators[validatorList[i]].active) count++;
        }
    }
}

interface IBlindEscrowDispute {
    function resolveDispute(uint256 taskId, bool workerFavored) external;
}
