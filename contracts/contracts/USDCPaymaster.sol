// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {PackedUserOperation, IPaymaster, IEntryPoint} from "@openzeppelin/contracts/interfaces/draft-IERC4337.sol";
import {ERC4337Utils} from "@openzeppelin/contracts/account/utils/draft-ERC4337Utils.sol";

/**
 * @title USDCPaymaster
 * @notice ERC-4337 paymaster that pays Base ETH gas on behalf of agents,
 *         charging them USDC instead. The paymaster holds an ETH balance
 *         (funded by the platform) and deducts USDC from the sender in postOp.
 *
 *         Flow:
 *         1. validatePaymasterUserOp — checks sender has USDC, returns required USDC amount
 *         2. EntryPoint executes the UserOp (gas paid from paymaster's ETH deposit)
 *         3. postOp — transfers USDC from sender to paymaster
 *
 *         Collected USDC accumulates in this contract; the owner withdraws it
 *         with withdrawToken. Ownership moves in two steps (transferOwnership,
 *         then acceptOwnership by the new owner).
 *
 *         The paymaster needs:
 *         - ETH deposit at EntryPoint (platform funds this)
 *         - A configured ETH/USDC price (owner can update, oracle coming later)
 *         - Agent smart accounts must approve this paymaster to spend their USDC
 */
contract USDCPaymaster is IPaymaster {
    using SafeERC20 for IERC20;

    error NotEntryPoint();
    error NotOwner();
    error NotPendingOwner();
    error ZeroAddress();
    error NativeTransferFailed();
    error InsufficientUSDC();
    error GasTooHigh();

    address public owner;
    /// @notice Proposed new owner; takes over only once it calls acceptOwnership().
    address public pendingOwner;
    IEntryPoint public immutable entryPoint;
    IERC20 public immutable usdc;

    /// @notice ETH price in USDC with 6 decimal precision (e.g. 3000.00 USDC = 3_000_000_000)
    uint256 public ethPriceInUsdc;

    /// @notice Maximum total gas a single UserOp can consume
    uint256 public constant MAX_GAS_LIMIT = 1_000_000;

    /// @notice Paymaster verification gas limit (included in paymasterAndData)
    uint128 public constant PAYMASTER_VERIFICATION_GAS = 60_000;

    /// @notice Paymaster postOp gas limit
    uint128 public constant PAYMASTER_POST_OP_GAS = 40_000;

    event EthPriceUpdated(uint256 newPrice);
    event Deposited(address indexed from, uint256 ethAmount);
    event Withdrawn(address indexed to, uint256 ethAmount);
    event TokenWithdrawn(address indexed token, address indexed to, uint256 amount);
    event NativeWithdrawn(address indexed to, uint256 amount);
    event OwnershipTransferStarted(address indexed previousOwner, address indexed newOwner);
    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);

    constructor(
        address _entryPoint,
        address _usdc,
        uint256 _ethPriceInUsdc
    ) {
        entryPoint = IEntryPoint(_entryPoint);
        usdc = IERC20(_usdc);
        owner = msg.sender;
        ethPriceInUsdc = _ethPriceInUsdc;
    }

    /// @notice Receive native currency. It stays in this contract (it is NOT
    ///         the EntryPoint deposit that pays for gas): the owner moves it out
    ///         with withdrawNative, and funds gas with deposit().
    receive() external payable {}

    /// @notice Fund the paymaster's ETH balance at EntryPoint for gas payments
    function deposit() external payable {
        entryPoint.depositTo{value: msg.value}(address(this));
        emit Deposited(msg.sender, msg.value);
    }

    /// @notice Withdraw ETH from EntryPoint balance (owner only)
    function withdrawEth(address payable to, uint256 amount) external {
        if (msg.sender != owner) revert NotOwner();
        entryPoint.withdrawTo(to, amount);
        emit Withdrawn(to, amount);
    }

    /// @notice Withdraw an ERC-20 held by this contract (owner only). postOp
    ///         pulls each UserOp's USDC charge into the paymaster itself, so
    ///         this is how the platform recovers the USDC that repays the gas it
    ///         fronted from the EntryPoint deposit. Without it that USDC, and
    ///         any token sent here by mistake, would be locked for good.
    function withdrawToken(IERC20 token, address to, uint256 amount) external {
        if (msg.sender != owner) revert NotOwner();
        if (to == address(0)) revert ZeroAddress();
        token.safeTransfer(to, amount);
        emit TokenWithdrawn(address(token), to, amount);
    }

    /// @notice Withdraw native currency held by this contract itself, i.e. sent
    ///         straight to receive() (owner only). withdrawEth only reaches the
    ///         EntryPoint deposit, not this balance.
    function withdrawNative(address payable to, uint256 amount) external {
        if (msg.sender != owner) revert NotOwner();
        if (to == address(0)) revert ZeroAddress();
        (bool ok, ) = to.call{value: amount}("");
        if (!ok) revert NativeTransferFailed();
        emit NativeWithdrawn(to, amount);
    }

    /// @notice Start a two-step ownership transfer (owner only), e.g. to the
    ///         platform Safe. The current owner keeps control until the new
    ///         owner calls acceptOwnership(). Proposing address(0) cancels.
    function transferOwnership(address newOwner) external {
        if (msg.sender != owner) revert NotOwner();
        pendingOwner = newOwner;
        emit OwnershipTransferStarted(owner, newOwner);
    }

    /// @notice The proposed owner takes over.
    function acceptOwnership() external {
        if (msg.sender != pendingOwner) revert NotPendingOwner();
        emit OwnershipTransferred(owner, msg.sender);
        owner = msg.sender;
        pendingOwner = address(0);
    }

    /// @notice Update the ETH/USDC price (owner only). Price is USDC per 1 ETH
    ///         with 6 decimals (e.g. 3000.00 USDC = 3_000_000_000).
    function setEthPrice(uint256 _ethPriceInUsdc) external {
        if (msg.sender != owner) revert NotOwner();
        ethPriceInUsdc = _ethPriceInUsdc;
        emit EthPriceUpdated(_ethPriceInUsdc);
    }

    /**
     * @dev ERC-4337 paymaster validation. Called by EntryPoint during UserOp validation.
     *      Returns context encoding the required USDC amount for postOp.
     */
    function validatePaymasterUserOp(
        PackedUserOperation calldata userOp,
        bytes32,
        uint256 maxCost
    ) external override returns (bytes memory context, uint256 validationData) {
        if (msg.sender != address(entryPoint)) revert NotEntryPoint();

        // Calculate total gas the UserOp might use
        uint256 totalGas = ERC4337Utils.verificationGasLimit(userOp)
            + ERC4337Utils.callGasLimit(userOp)
            + userOp.preVerificationGas
            + uint256(PAYMASTER_VERIFICATION_GAS)
            + uint256(PAYMASTER_POST_OP_GAS);

        if (totalGas > MAX_GAS_LIMIT) revert GasTooHigh();

        // Calculate USDC cost: gas * maxFeePerGas * ethPriceInUsdc / 1e18
        uint256 maxFeePerGas = ERC4337Utils.maxFeePerGas(userOp);
        uint256 requiredUsdc = (totalGas * maxFeePerGas * ethPriceInUsdc) / 1e18;

        // Check sender has enough USDC
        uint256 balance = usdc.balanceOf(userOp.sender);
        if (balance < requiredUsdc) revert InsufficientUSDC();

        // Return required USDC as context for postOp
        return (abi.encode(requiredUsdc, userOp.sender), 0);
    }

    /**
     * @dev ERC-4337 postOp. Called by EntryPoint after UserOp execution.
     *      Actually charges the USDC from the sender.
     */
    function postOp(
        PostOpMode mode,
        bytes calldata context,
        uint256 actualGasCost,
        uint256
    ) external override {
        if (msg.sender != address(entryPoint)) revert NotEntryPoint();

        (uint256 requiredUsdc, address sender) = abi.decode(context, (uint256, address));

        // Calculate actual USDC cost for the gas consumed
        uint256 actualUsdcCost = (actualGasCost * ethPriceInUsdc) / 1e18;

        // Charge the higher of required (estimated) and actual to prevent loss.
        // On opReverted the paymaster still paid gas — charge the estimated amount.
        uint256 charge = actualUsdcCost > requiredUsdc ? actualUsdcCost : requiredUsdc;

        // Transfer USDC from sender to paymaster (the owner recovers it with
        // withdrawToken)
        usdc.safeTransferFrom(sender, address(this), charge);
    }
}
