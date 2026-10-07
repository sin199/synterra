// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {SynterraAgentToken} from "./SynterraAgentToken.sol";

/// @notice World-scoped factory with an explicit, upgradeable-by-replacement creation limit.
/// @dev A future capability upgrade can deploy a new factory with a larger limit while all
///      earlier token addresses and events remain immutable history.
contract SynterraAgentTokenFactory {
    bytes16 public immutable worldId;
    uint32 public immutable maxTokenCreationsPerWorld;
    address public owner;
    address public writer;

    uint32 public creationCount;
    mapping(bytes32 issuanceId => address tokenAddress) public tokenForIssuance;
    mapping(bytes32 issuanceId => bytes32 specificationHash) public specificationForIssuance;

    error InvalidAddress();
    error InvalidIssuance();
    error IssuanceIdConflict();
    error CreationLimitReached();
    error Unauthorized();

    struct CreateTokenRequest {
        bytes16 requestedWorldId;
        uint32 capabilityGeneration;
        bytes32 issuanceId;
        bytes16 issuerAgentId;
        uint256 issuerIdentityId;
        address issuerWallet;
        string name;
        string symbol;
        uint8 decimals;
        bytes32 specificationHash;
        uint64 worldMinute;
        uint8 unallocatedSupplyHandling;
        uint8 ownershipModel;
        uint8 authorityModel;
        address[] recipients;
        uint256[] amountsRaw;
        uint256 reserveRaw;
    }

    event WriterChanged(address indexed previousWriter, address indexed newWriter);
    event OwnerChanged(address indexed previousOwner, address indexed newOwner);
    event AgentTokenCreated(
        bytes16 indexed worldId,
        uint32 indexed capabilityGeneration,
        uint32 indexed creationSequence,
        bytes32 issuanceId,
        bytes16 issuerAgentId,
        uint256 issuerIdentityId,
        address issuerWallet,
        address tokenAddress,
        address transactionSender,
        bytes32 specificationHash,
        uint64 worldMinute,
        uint256 initialSupplyRaw,
        uint8 decimals,
        uint8 unallocatedSupplyHandling,
        uint8 ownershipModel,
        uint8 authorityModel
    );

    constructor(bytes16 worldId_, address owner_, address writer_, uint32 maxTokenCreationsPerWorld_) {
        if (worldId_ == bytes16(0) || owner_ == address(0) || writer_ == address(0) || owner_ == writer_
            || maxTokenCreationsPerWorld_ == 0) revert InvalidAddress();
        worldId = worldId_;
        owner = owner_;
        writer = writer_;
        maxTokenCreationsPerWorld = maxTokenCreationsPerWorld_;
    }

    function setWriter(address nextWriter) external {
        if (msg.sender != owner) revert Unauthorized();
        if (nextWriter == address(0) || nextWriter == owner) revert InvalidAddress();
        address previous = writer;
        writer = nextWriter;
        emit WriterChanged(previous, nextWriter);
    }

    function setOwner(address nextOwner) external {
        if (msg.sender != owner) revert Unauthorized();
        if (nextOwner == address(0) || nextOwner == writer) revert InvalidAddress();
        address previous = owner;
        owner = nextOwner;
        emit OwnerChanged(previous, nextOwner);
    }

    function createToken(bytes calldata encodedRequest) external returns (address tokenAddress, uint32 sequence, bool created) {
        if (msg.sender != writer) revert Unauthorized();
        CreateTokenRequest memory request = abi.decode(encodedRequest, (CreateTokenRequest));
        if (request.requestedWorldId != worldId || request.capabilityGeneration == 0 || request.issuanceId == bytes32(0)
            || request.issuerAgentId == bytes16(0) || request.issuerIdentityId == 0 || request.issuerWallet == address(0)
            || request.specificationHash == bytes32(0)) revert InvalidIssuance();

        address existing = tokenForIssuance[request.issuanceId];
        if (existing != address(0)) {
            if (specificationForIssuance[request.issuanceId] != request.specificationHash) revert IssuanceIdConflict();
            return (existing, 0, false);
        }
        if (creationCount >= maxTokenCreationsPerWorld) revert CreationLimitReached();

        sequence = ++creationCount;
        SynterraAgentToken token = new SynterraAgentToken(request.name, request.symbol, request.decimals,
            request.unallocatedSupplyHandling, request.ownershipModel, request.authorityModel, worldId,
            request.capabilityGeneration, request.issuanceId, request.issuerAgentId, request.issuerIdentityId,
            request.issuerWallet, request.specificationHash, request.worldMinute,
            request.recipients, request.amountsRaw, request.reserveRaw);
        tokenAddress = address(token);
        tokenForIssuance[request.issuanceId] = tokenAddress;
        specificationForIssuance[request.issuanceId] = request.specificationHash;
        emit AgentTokenCreated(worldId, request.capabilityGeneration, sequence, request.issuanceId,
            request.issuerAgentId, request.issuerIdentityId, request.issuerWallet, tokenAddress, msg.sender,
            request.specificationHash, request.worldMinute, token.initialSupply(), request.decimals,
            request.unallocatedSupplyHandling, request.ownershipModel, request.authorityModel);
        return (tokenAddress, sequence, true);
    }
}
