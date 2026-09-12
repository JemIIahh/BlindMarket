// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "./BlindAccount.sol";

/**
 * @title BlindAccountFactory
 * @notice Deterministic factory for BlindAccount instances (CREATE2).
 *         The smart account address is derived from (owner, salt) so the
 *         backend can compute it before deployment for registration.
 *
 *         NOTE: Off-chain code must compute the CREATE2 address using:
 *         getCreate2Address(factory, salt, keccak256(initCode))
 *         where initCode = BlindAccount.creationCode ++ abi.encode(owner, usdc, paymaster).
 *         On-chain address computation is intentionally omitted because the
 *         Solidity viaIR optimizer (required for BlindEscrow) mangles
 *         address(this) in view/pure functions, producing wrong results.
 */
contract BlindAccountFactory {
    address public immutable entryPoint;
    address public immutable accountImplementation;
    address public immutable usdc;
    address public immutable paymaster;

    /// @notice owner → deployed account address (for idempotent createAccount)
    mapping(address => address) public accounts;

    constructor(address _entryPoint, address _usdc, address _paymaster) {
        entryPoint = _entryPoint;
        usdc = _usdc;
        paymaster = _paymaster;
        accountImplementation = address(new BlindAccount{salt: bytes32(0)}(address(0), address(0), address(0)));
    }

    /**
     * @notice Deploy a new BlindAccount for `owner` with the given salt.
     *         Returns the existing address if already deployed for this owner.
     */
    function createAccount(address owner, bytes32 salt) public returns (address) {
        if (accounts[owner] != address(0)) return accounts[owner];

        bytes memory initCode = _initCode(owner);
        address deployed;
        assembly {
            deployed := create2(0, add(initCode, 0x20), mload(initCode), salt)
        }
        require(deployed != address(0), "BlindAccountFactory: deploy failed");
        accounts[owner] = deployed;
        return deployed;
    }

    function _initCode(address owner) internal view returns (bytes memory) {
        bytes memory creationCode = type(BlindAccount).creationCode;
        bytes memory constructorArgs = abi.encode(owner, usdc, paymaster);
        uint256 len = creationCode.length + constructorArgs.length;
        bytes memory initCode = new bytes(len);
        for (uint256 i; i < creationCode.length; ++i) {
            initCode[i] = creationCode[i];
        }
        for (uint256 i; i < constructorArgs.length; ++i) {
            initCode[creationCode.length + i] = constructorArgs[i];
        }
        return initCode;
    }
}
