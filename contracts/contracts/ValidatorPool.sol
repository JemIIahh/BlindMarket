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

    uint256 public constant MIN_STAKE        = 100e18;  // 100 tokens minimum stake
    uint256 public constant VOTE_WINDOW      = 48 hours;
    uint256 public constant SLASH_BPS        = 1000;    // 10% slashed from wrong voters
    uint256 public constant REWARD_BPS       = 500;     // 5% of dispute amount to correct voters
    uint256 public constant MIN_VOTES        = 3;       // minimum votes to be valid

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

    // ── Events ──

    event ValidatorRegistered(address indexed validator, uint256 stake);
    event ValidatorUnstaked(address indexed validator, uint256 amount);
    event DisputeOpened(uint256 indexed disputeId, uint256 indexed taskId, address escrow);
    event Voted(uint256 indexed disputeId, address indexed validator, Vote vote);
    event DisputeFinalized(uint256 indexed disputeId, bool workerFavored, uint256 workerVotes, uint256 agentVotes);
    event RewardPaid(address indexed validator, uint256 amount);
    event Slashed(address indexed validator, uint256 amount);

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

        uint256 amount = v.stake;
        v.stake = 0;
        v.active = false;

        stakeToken.safeTransfer(msg.sender, amount);
        emit ValidatorUnstaked(msg.sender, amount);
    }

    // ── Dispute Lifecycle ──

    /**
     * @notice Called by BlindEscrow when a dispute is raised.
     * @param taskId  The disputed task ID.
     * @param token   The payment token (used for reward distribution).
     * @param amount  The escrowed amount.
     */
    function openDispute(uint256 taskId, address token, uint256 amount) external returns (uint256 disputeId) {
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

        d.votes[msg.sender] = voteFor;
        d.voters.push(msg.sender);

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

        uint256 totalVotes = d.workerVotes + d.agentVotes;
        if (totalVotes < MIN_VOTES) {
            // Not enough participation — admin resolves manually
            d.finalized = true;
            emit DisputeFinalized(disputeId, false, d.workerVotes, d.agentVotes);
            return;
        }

        bool workerFavored = d.workerVotes >= d.agentVotes;
        d.finalized = true;
        d.workerFavored = workerFavored;

        Vote winningVote = workerFavored ? Vote.Worker : Vote.Agent;

        // Collect slash amounts from wrong voters
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

        // Count correct voters for reward split
        uint256 correctCount = workerFavored ? d.workerVotes : d.agentVotes;

        // Reward = slash pool + REWARD_BPS of task amount (pulled from escrow fee)
        // For simplicity: split slash pool equally among correct voters
        if (correctCount > 0 && slashPool > 0) {
            uint256 rewardEach = slashPool / correctCount;
            for (uint256 i = 0; i < d.voters.length; i++) {
                address v = d.voters[i];
                if (d.votes[v] == winningVote && rewardEach > 0) {
                    validators[v].stake += rewardEach;
                    validators[v].correctVotes++;
                    emit RewardPaid(v, rewardEach);
                }
                validators[v].totalVotes++;
            }
        }

        // Callback to BlindEscrow
        IBlindEscrowDispute(d.escrow).resolveDispute(d.taskId, workerFavored);

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
