// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

contract SynterraCapabilityProvenance {
    error Unauthorized();
    error InvalidAddress();
    error InvalidCapability();
    error InvalidParent();
    error InvalidVersion();
    error InvalidOrigin();

    enum CreatorType { None, DeveloperSeeded, Resident, Organization }
    enum CapabilityStatus { None, Proposed, Experimental, Active, Deprecated, Rejected }

    bytes16 public immutable worldId;
    address public owner;
    address public writer;
    uint64 public latestWorldMinute;
    mapping(bytes16 capabilityId => uint64 version) public latestVersion;
    mapping(bytes16 capabilityId => bytes16 parentCapabilityId) public parentCapability;

    event OwnerChanged(address indexed previousOwner, address indexed newOwner);
    event WriterChanged(address indexed previousWriter, address indexed newWriter);
    event CapabilityAnchored(bytes16 indexed worldId, bytes16 indexed capabilityId,
        CreatorType indexed creatorType, bytes16 creatorId, bytes16 parentCapabilityId,
        bytes32 specificationHash, uint64 version, uint64 worldMinute,
        uint64 adoptedWorldMinute, CapabilityStatus status);

    constructor(bytes16 worldId_, address owner_, address writer_) {
        if (worldId_ == bytes16(0) || owner_ == address(0) || writer_ == address(0) || owner_ == writer_) {
            revert InvalidAddress();
        }
        worldId = worldId_;
        owner = owner_;
        writer = writer_;
    }

    modifier onlyOwner() {
        if (msg.sender != owner) revert Unauthorized();
        _;
    }

    function setOwner(address nextOwner) external onlyOwner {
        if (nextOwner == address(0) || nextOwner == writer) revert InvalidAddress();
        address previous = owner;
        owner = nextOwner;
        emit OwnerChanged(previous, nextOwner);
    }

    function setWriter(address nextWriter) external onlyOwner {
        if (nextWriter == address(0) || nextWriter == owner) revert InvalidAddress();
        address previous = writer;
        writer = nextWriter;
        emit WriterChanged(previous, nextWriter);
    }

    function anchor(bytes16 capabilityId, CreatorType creatorType, bytes16 creatorId,
        bytes16 parentCapabilityId, bytes32 specificationHash, uint64 version,
        uint64 worldMinute, uint64 adoptedWorldMinute, CapabilityStatus status) external {
        if (msg.sender != writer) revert Unauthorized();
        if (capabilityId == bytes16(0) || specificationHash == bytes32(0) || version == 0
            || worldMinute < latestWorldMinute || adoptedWorldMinute > worldMinute) revert InvalidCapability();
        if (creatorType == CreatorType.None || status == CapabilityStatus.None
            || (creatorType == CreatorType.DeveloperSeeded && creatorId != bytes16(0))
            || ((creatorType == CreatorType.Resident || creatorType == CreatorType.Organization)
                && creatorId == bytes16(0))) revert InvalidOrigin();
        if (parentCapabilityId == capabilityId) revert InvalidParent();
        if (parentCapabilityId != bytes16(0) && latestVersion[parentCapabilityId] == 0) revert InvalidParent();
        uint64 currentVersion = latestVersion[capabilityId];
        if (version <= currentVersion) revert InvalidVersion();
        if (currentVersion == 0) parentCapability[capabilityId] = parentCapabilityId;
        else if (parentCapability[capabilityId] != parentCapabilityId) revert InvalidParent();
        latestVersion[capabilityId] = version;
        latestWorldMinute = worldMinute;
        emit CapabilityAnchored(worldId, capabilityId, creatorType, creatorId, parentCapabilityId,
            specificationHash, version, worldMinute, adoptedWorldMinute, status);
    }
}
