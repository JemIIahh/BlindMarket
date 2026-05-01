// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

interface IOracle {
    function verifyProof(bytes calldata proof) external view returns (bool);
}

/**
 * @title INFT — ERC-7857 Intelligent NFT
 * @notice ERC-721 extended with encrypted metadata, TEE-verified transfers,
 *         and usage authorization. Each token represents an AI agent whose
 *         intelligence (encrypted URI + metadata hash) transfers with ownership.
 */
contract INFT is ERC721, Ownable, ReentrancyGuard {
    // ── State ────────────────────────────────────────────────────────────────

    mapping(uint256 => string)  private _encryptedURIs;
    mapping(uint256 => bytes32) private _metadataHashes;
    mapping(uint256 => mapping(address => bytes)) private _authorizations;

    address public oracle;
    uint256 private _nextTokenId = 1;

    // ── Events ───────────────────────────────────────────────────────────────

    event INFTMinted(uint256 indexed tokenId, address indexed to, bytes32 metadataHash);
    event MetadataUpdated(uint256 indexed tokenId, bytes32 newHash, string newEncryptedURI);
    event UsageAuthorized(uint256 indexed tokenId, address indexed executor);
    event UsageRevoked(uint256 indexed tokenId, address indexed executor);
    event OracleUpdated(address indexed oldOracle, address indexed newOracle);

    // ── Constructor ──────────────────────────────────────────────────────────

    constructor(address _oracle) ERC721("BlindMarket Agent NFT", "BBNFT") Ownable(msg.sender) {
        require(_oracle != address(0), "Oracle required");
        oracle = _oracle;
    }

    // ── Mint ─────────────────────────────────────────────────────────────────

    /**
     * @notice Mint a new INFT for an AI agent.
     * @param to            Recipient (agent owner)
     * @param encryptedURI  0G Storage URI of AES-encrypted agent metadata
     * @param metadataHash  keccak256 of plaintext metadata (integrity anchor)
     */
    function mint(
        address to,
        string calldata encryptedURI,
        bytes32 metadataHash
    ) external onlyOwner returns (uint256 tokenId) {
        tokenId = _nextTokenId++;
        _safeMint(to, tokenId);
        _encryptedURIs[tokenId] = encryptedURI;
        _metadataHashes[tokenId] = metadataHash;
        emit INFTMinted(tokenId, to, metadataHash);
    }

    // ── ERC-7857: Transfer with re-encryption proof ───────────────────────────

    /**
     * @notice Transfer token + re-encrypted metadata to a new owner.
     *         TEE oracle re-encrypts agent metadata to `to`'s pubkey and produces proof.
     *
     * @param from      Current owner
     * @param to        New owner
     * @param tokenId   Token to transfer
     * @param proof     abi.encode(bytes32 newMetadataHash, string newEncryptedURI)
     *                  (4th param is sealedKey — ECIES-sealed AES key, delivered off-chain)
     */
    function transferWithProof(
        address from,
        address to,
        uint256 tokenId,
        bytes calldata, // sealedKey — off-chain delivery, not stored on-chain
        bytes calldata proof
    ) external nonReentrant {
        require(ownerOf(tokenId) == from, "Not owner");
        require(to != address(0), "Invalid recipient");
        require(
            msg.sender == from ||
            isApprovedForAll(from, msg.sender) ||
            getApproved(tokenId) == msg.sender,
            "Not approved"
        );
        require(IOracle(oracle).verifyProof(proof), "Invalid oracle proof");

        (bytes32 newHash, string memory newURI) = abi.decode(proof, (bytes32, string));
        _metadataHashes[tokenId] = newHash;
        _encryptedURIs[tokenId] = newURI;

        _transfer(from, to, tokenId);
        emit MetadataUpdated(tokenId, newHash, newURI);
    }

    // ── ERC-7857: Clone ───────────────────────────────────────────────────────

    /**
     * @notice Clone token — mint new INFT with same metadata re-encrypted for `to`.
     */
    function clone(
        address to,
        uint256 tokenId,
        bytes calldata, // sealedKey — off-chain delivery
        bytes calldata proof
    ) external nonReentrant returns (uint256 newTokenId) {
        require(ownerOf(tokenId) == msg.sender, "Not owner");
        require(IOracle(oracle).verifyProof(proof), "Invalid oracle proof");

        (bytes32 newHash, string memory newURI) = abi.decode(proof, (bytes32, string));
        newTokenId = _nextTokenId++;
        _safeMint(to, newTokenId);
        _encryptedURIs[newTokenId] = newURI;
        _metadataHashes[newTokenId] = newHash;
        emit INFTMinted(newTokenId, to, newHash);
    }

    // ── ERC-7857: Authorized Usage ────────────────────────────────────────────

    /**
     * @notice Grant usage rights without ownership transfer (AI-as-a-Service).
     * @param permissions  ABI-encoded (uint256 expiry, uint256 maxRequests)
     */
    function authorizeUsage(
        uint256 tokenId,
        address executor,
        bytes calldata permissions
    ) external {
        require(ownerOf(tokenId) == msg.sender, "Not owner");
        require(executor != address(0), "Invalid executor");
        _authorizations[tokenId][executor] = permissions;
        emit UsageAuthorized(tokenId, executor);
    }

    function revokeUsage(uint256 tokenId, address executor) external {
        require(ownerOf(tokenId) == msg.sender, "Not owner");
        delete _authorizations[tokenId][executor];
        emit UsageRevoked(tokenId, executor);
    }

    // ── Views ─────────────────────────────────────────────────────────────────

    function getEncryptedURI(uint256 tokenId) external view returns (string memory) {
        _requireOwned(tokenId);
        return _encryptedURIs[tokenId];
    }

    function getMetadataHash(uint256 tokenId) external view returns (bytes32) {
        _requireOwned(tokenId);
        return _metadataHashes[tokenId];
    }

    function getAuthorization(uint256 tokenId, address executor) external view returns (bytes memory) {
        return _authorizations[tokenId][executor];
    }

    function isAuthorized(uint256 tokenId, address executor) external view returns (bool) {
        return _authorizations[tokenId][executor].length > 0;
    }

    // ── Admin ─────────────────────────────────────────────────────────────────

    function setOracle(address newOracle) external onlyOwner {
        require(newOracle != address(0), "Oracle required");
        emit OracleUpdated(oracle, newOracle);
        oracle = newOracle;
    }
}
