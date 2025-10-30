pragma solidity ^0.8.24;

import { FHE, euint32, ebool } from "@fhevm/solidity/lib/FHE.sol";
import { SepoliaConfig } from "@fhevm/solidity/config/ZamaConfig.sol";


contract ComputeLendingFHE is SepoliaConfig {
    using FHE for euint32;
    using FHE for ebool;

    address public owner;
    mapping(address => bool) public isProvider;
    bool public paused;
    uint256 public cooldownSeconds;
    mapping(address => uint256) public lastSubmissionTime;
    mapping(address => uint256) public lastDecryptionRequestTime;

    uint256 public currentBatchId;
    mapping(uint256 => bool) public isBatchOpen;
    mapping(uint256 => uint256) public batchTotalEncryptedComputeUnits;
    mapping(uint256 => uint256) public batchTotalEncryptedLendAmounts;

    struct DecryptionContext {
        uint256 batchId;
        bytes32 stateHash;
        bool processed;
    }
    mapping(uint256 => DecryptionContext) public decryptionContexts;

    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);
    event ProviderAdded(address indexed provider);
    event ProviderRemoved(address indexed provider);
    event PauseToggled(bool indexed paused);
    event CooldownSecondsSet(uint256 indexed oldCooldown, uint256 indexed newCooldown);
    event BatchOpened(uint256 indexed batchId);
    event BatchClosed(uint256 indexed batchId);
    event ComputeResourceSubmitted(address indexed provider, uint256 indexed batchId, bytes32 encryptedComputeUnits, bytes32 encryptedLendAmount);
    event DecryptionRequested(uint256 indexed requestId, uint256 indexed batchId, bytes32 stateHash);
    event DecryptionCompleted(uint256 indexed requestId, uint256 indexed batchId, uint256 totalComputeUnits, uint256 totalLendAmount);

    error NotOwner();
    error NotProvider();
    error Paused();
    error CooldownActive();
    error BatchClosedOrNonExistent();
    error ReplayDetected();
    error StateMismatch();
    error InvalidBatchId();

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    modifier onlyProvider() {
        if (!isProvider[msg.sender]) revert NotProvider();
        _;
    }

    modifier whenNotPaused() {
        if (paused) revert Paused();
        _;
    }

    constructor() {
        owner = msg.sender;
        emit OwnershipTransferred(address(0), msg.sender);
    }

    function transferOwnership(address newOwner) external onlyOwner {
        address previousOwner = owner;
        owner = newOwner;
        emit OwnershipTransferred(previousOwner, newOwner);
    }

    function addProvider(address provider) external onlyOwner {
        if (!isProvider[provider]) {
            isProvider[provider] = true;
            emit ProviderAdded(provider);
        }
    }

    function removeProvider(address provider) external onlyOwner {
        if (isProvider[provider]) {
            isProvider[provider] = false;
            emit ProviderRemoved(provider);
        }
    }

    function setPaused(bool _paused) external onlyOwner {
        paused = _paused;
        emit PauseToggled(_paused);
    }

    function setCooldownSeconds(uint256 newCooldownSeconds) external onlyOwner {
        uint256 oldCooldown = cooldownSeconds;
        cooldownSeconds = newCooldownSeconds;
        emit CooldownSecondsSet(oldCooldown, newCooldownSeconds);
    }

    function openBatch() external onlyOwner whenNotPaused {
        currentBatchId++;
        isBatchOpen[currentBatchId] = true;
        emit BatchOpened(currentBatchId);
    }

    function closeBatch(uint256 batchId) external onlyOwner {
        if (!isBatchOpen[batchId]) revert BatchClosedOrNonExistent();
        isBatchOpen[batchId] = false;
        emit BatchClosed(batchId);
    }

    function submitEncryptedComputeResource(
        uint256 batchId,
        euint32 encryptedComputeUnits,
        euint32 encryptedLendAmount
    ) external onlyProvider whenNotPaused {
        if (block.timestamp < lastSubmissionTime[msg.sender] + cooldownSeconds) {
            revert CooldownActive();
        }
        if (!isBatchOpen[batchId]) revert BatchClosedOrNonExistent();

        lastSubmissionTime[msg.sender] = block.timestamp;

        _initIfNeeded(encryptedComputeUnits);
        _initIfNeeded(encryptedLendAmount);

        batchTotalEncryptedComputeUnits[batchId] = FHE.toBytes32(encryptedComputeUnits.add(FHE.asEuint32(batchTotalEncryptedComputeUnits[batchId])));
        batchTotalEncryptedLendAmounts[batchId] = FHE.toBytes32(encryptedLendAmount.add(FHE.asEuint32(batchTotalEncryptedLendAmounts[batchId])));

        emit ComputeResourceSubmitted(msg.sender, batchId, FHE.toBytes32(encryptedComputeUnits), FHE.toBytes32(encryptedLendAmount));
    }

    function requestBatchDecryption(uint256 batchId) external onlyOwner whenNotPaused {
        if (block.timestamp < lastDecryptionRequestTime[msg.sender] + cooldownSeconds) {
            revert CooldownActive();
        }
        if (isBatchOpen[batchId]) revert BatchClosedOrNonExistent(); // Must be closed to finalize

        lastDecryptionRequestTime[msg.sender] = block.timestamp;

        bytes32[] memory cts = new bytes32[](2);
        cts[0] = batchTotalEncryptedComputeUnits[batchId];
        cts[1] = batchTotalEncryptedLendAmounts[batchId];

        bytes32 stateHash = _hashCiphertexts(cts);

        uint256 requestId = FHE.requestDecryption(cts, this.myCallback.selector);

        decryptionContexts[requestId] = DecryptionContext({ batchId: batchId, stateHash: stateHash, processed: false });

        emit DecryptionRequested(requestId, batchId, stateHash);
    }

    function myCallback(uint256 requestId, bytes memory cleartexts, bytes memory proof) public {
        if (decryptionContexts[requestId].processed) revert ReplayDetected();

        uint256 batchId = decryptionContexts[requestId].batchId;
        if (!isBatchOpen[batchId] && batchTotalEncryptedComputeUnits[batchId] == 0) { // Check if batchId is valid and has data
             revert InvalidBatchId();
        }

        bytes32[] memory cts = new bytes32[](2);
        cts[0] = batchTotalEncryptedComputeUnits[batchId];
        cts[1] = batchTotalEncryptedLendAmounts[batchId];

        bytes32 currentHash = _hashCiphertexts(cts); // Recalculate hash from current storage

        if (currentHash != decryptionContexts[requestId].stateHash) {
            revert StateMismatch();
        }

        FHE.checkSignatures(requestId, cleartexts, proof);

        uint256 totalComputeUnits = abi.decode(cleartexts, (uint256));
        uint256 totalLendAmount; // Second value is not used in this example, but decoded if needed
        assembly { totalLendAmount := mload(add(add(cleartexts, 0x20), 0x20)) }

        decryptionContexts[requestId].processed = true;
        emit DecryptionCompleted(requestId, batchId, totalComputeUnits, totalLendAmount);
    }

    function _hashCiphertexts(bytes32[] memory cts) internal pure returns (bytes32) {
        return keccak256(abi.encode(cts, address(this)));
    }

    function _initIfNeeded(euint32 val) internal {
        if (!FHE.isInitialized(val)) {
            FHE.asEuint32(0); // Initialize if not already
        }
    }

    function _requireInitialized(euint32 val) internal pure {
        if (!FHE.isInitialized(val)) revert("FHE value not initialized");
    }
}