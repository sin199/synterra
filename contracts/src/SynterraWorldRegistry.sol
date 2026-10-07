// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

contract SynterraWorldRegistry {
    error Unauthorized();
    error InvalidAddress();
    error InvalidCheckpoint();
    error InvalidResident();
    error WalletAlreadyLinked();

    bytes16 public immutable worldId;
    address public owner;
    address public checkpointWriter;
    address public identityWriter;
    uint64 public latestWorldMinute;
    uint64 public latestEpoch;
    uint64 public latestCheckpointVersion;

    mapping(bytes16 residentId => address wallet) public residentWallets;
    mapping(address wallet => bytes16 residentId) public residentForWallet;
    mapping(bytes16 residentId => uint256 erc8004AgentId) public erc8004AgentIds;

    event OwnerChanged(address indexed previousOwner, address indexed newOwner);
    event CheckpointWriterChanged(address indexed previousWriter, address indexed newWriter);
    event IdentityWriterChanged(address indexed previousWriter, address indexed newWriter);
    event ResidentWalletLinked(bytes16 indexed residentId, address indexed previousWallet, address indexed wallet,
        uint256 erc8004AgentId);
    event WorldCheckpoint(bytes16 indexed worldId, uint64 indexed worldMinute, uint64 indexed version,
        uint64 epoch, bytes32 historyRoot, bytes32 simulationLedgerRoot, bytes32 capabilityRoot);

    constructor(bytes16 worldId_, address owner_, address checkpointWriter_, address identityWriter_) {
        if (worldId_ == bytes16(0) || owner_ == address(0) || checkpointWriter_ == address(0)
            || identityWriter_ == address(0) || owner_ == checkpointWriter_ || owner_ == identityWriter_
            || checkpointWriter_ == identityWriter_) revert InvalidAddress();
        worldId = worldId_;
        owner = owner_;
        checkpointWriter = checkpointWriter_;
        identityWriter = identityWriter_;
    }

    modifier onlyOwner() {
        if (msg.sender != owner) revert Unauthorized();
        _;
    }

    function setOwner(address nextOwner) external onlyOwner {
        if (nextOwner == address(0) || nextOwner == checkpointWriter || nextOwner == identityWriter) {
            revert InvalidAddress();
        }
        address previous = owner;
        owner = nextOwner;
        emit OwnerChanged(previous, nextOwner);
    }

    function setCheckpointWriter(address nextWriter) external onlyOwner {
        if (nextWriter == address(0) || nextWriter == owner || nextWriter == identityWriter) revert InvalidAddress();
        address previous = checkpointWriter;
        checkpointWriter = nextWriter;
        emit CheckpointWriterChanged(previous, nextWriter);
    }

    function setIdentityWriter(address nextWriter) external onlyOwner {
        if (nextWriter == address(0) || nextWriter == owner || nextWriter == checkpointWriter) revert InvalidAddress();
        address previous = identityWriter;
        identityWriter = nextWriter;
        emit IdentityWriterChanged(previous, nextWriter);
    }

    function linkResident(bytes16 residentId, address wallet, uint256 erc8004AgentId) external {
        if (msg.sender != identityWriter) revert Unauthorized();
        if (residentId == bytes16(0) || wallet == address(0)) revert InvalidResident();
        bytes16 currentResident = residentForWallet[wallet];
        if (currentResident != bytes16(0) && currentResident != residentId) revert WalletAlreadyLinked();
        address previous = residentWallets[residentId];
        if (previous != address(0) && previous != wallet) delete residentForWallet[previous];
        residentWallets[residentId] = wallet;
        residentForWallet[wallet] = residentId;
        erc8004AgentIds[residentId] = erc8004AgentId;
        emit ResidentWalletLinked(residentId, previous, wallet, erc8004AgentId);
    }

    function checkpoint(uint64 worldMinute, uint64 epoch, uint64 version,
        bytes32 historyRoot, bytes32 simulationLedgerRoot, bytes32 capabilityRoot) external {
        if (msg.sender != checkpointWriter) revert Unauthorized();
        if (worldMinute <= latestWorldMinute || epoch < latestEpoch || version <= latestCheckpointVersion
            || historyRoot == bytes32(0) || simulationLedgerRoot == bytes32(0) || capabilityRoot == bytes32(0)) {
            revert InvalidCheckpoint();
        }
        latestWorldMinute = worldMinute;
        latestEpoch = epoch;
        latestCheckpointVersion = version;
        emit WorldCheckpoint(worldId, worldMinute, version, epoch,
            historyRoot, simulationLedgerRoot, capabilityRoot);
    }
}
