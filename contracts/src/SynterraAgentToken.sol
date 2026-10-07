// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @notice An Agent-authored ERC-20 whose creation provenance is fixed at deployment.
/// @dev Reserved supply is held by the token contract itself and can only be released by
///      the selected issuer wallet. The decimals limit is this pilot primitive's runtime limit.
contract SynterraAgentToken is ERC20 {
    uint8 public constant MAX_DECIMALS = 18;

    bytes16 public immutable worldId;
    uint32 public immutable capabilityGeneration;
    bytes32 public immutable issuanceId;
    bytes16 public immutable issuerAgentId;
    uint256 public immutable issuerIdentityId;
    address public immutable issuerWallet;
    bytes32 public immutable specificationHash;
    uint64 public immutable createdWorldMinute;
    uint8 private immutable tokenDecimals;
    uint8 public immutable unallocatedSupplyHandling;
    uint8 public immutable ownershipModel;
    uint8 public immutable authorityModel;
    uint256 public immutable initialSupply;
    uint256 public reservedSupply;
    mapping(bytes32 releaseId => bool used) public releasedReserveIds;

    error InvalidIssuance();
    error InvalidAllocation();
    error IssuerOnly();
    error ReserveExceeded();

    event ReserveReleased(
        bytes16 indexed worldId,
        bytes32 indexed issuanceId,
        bytes32 indexed releaseId,
        address issuerWallet,
        address[] recipients,
        uint256[] amountsRaw,
        uint256 remainingReservedRaw,
        uint64 worldMinute
    );

    constructor(
        string memory name_,
        string memory symbol_,
        uint8 decimals_,
        uint8 unallocatedSupplyHandling_,
        uint8 ownershipModel_,
        uint8 authorityModel_,
        bytes16 worldId_,
        uint32 capabilityGeneration_,
        bytes32 issuanceId_,
        bytes16 issuerAgentId_,
        uint256 issuerIdentityId_,
        address issuerWallet_,
        bytes32 specificationHash_,
        uint64 worldMinute_,
        address[] memory recipients_,
        uint256[] memory amountsRaw_,
        uint256 reserveRaw_
    ) ERC20(name_, symbol_) {
        if (bytes(name_).length == 0 || bytes(symbol_).length == 0 || decimals_ > MAX_DECIMALS
            || worldId_ == bytes16(0) || capabilityGeneration_ == 0 || issuanceId_ == bytes32(0)
            || issuerAgentId_ == bytes16(0) || issuerIdentityId_ == 0 || issuerWallet_ == address(0)
            || specificationHash_ == bytes32(0) || recipients_.length != amountsRaw_.length
            || ownershipModel_ != 0 || unallocatedSupplyHandling_ > 2 || authorityModel_ > 2) {
            revert InvalidIssuance();
        }

        uint256 total = 1_000_000_000 * (10 ** uint256(decimals_));
        uint256 allocated;
        for (uint256 i; i < recipients_.length; ++i) {
            if (recipients_[i] == address(0) || amountsRaw_[i] == 0) revert InvalidAllocation();
            allocated += amountsRaw_[i];
            _mint(recipients_[i], amountsRaw_[i]);
        }
        if (allocated + reserveRaw_ != total) revert InvalidAllocation();
        if ((unallocatedSupplyHandling_ == 0 && (reserveRaw_ != 0 || authorityModel_ != 0))
            || (unallocatedSupplyHandling_ == 1 && (reserveRaw_ == 0 || authorityModel_ != 1))
            || (unallocatedSupplyHandling_ == 2 && (reserveRaw_ == 0 || authorityModel_ != 2))) {
            revert InvalidAllocation();
        }
        if (reserveRaw_ != 0) _mint(address(this), reserveRaw_);

        worldId = worldId_;
        capabilityGeneration = capabilityGeneration_;
        issuanceId = issuanceId_;
        issuerAgentId = issuerAgentId_;
        issuerIdentityId = issuerIdentityId_;
        issuerWallet = issuerWallet_;
        specificationHash = specificationHash_;
        createdWorldMinute = worldMinute_;
        tokenDecimals = decimals_;
        unallocatedSupplyHandling = unallocatedSupplyHandling_;
        ownershipModel = ownershipModel_;
        authorityModel = authorityModel_;
        initialSupply = total;
        reservedSupply = reserveRaw_;
    }

    function decimals() public view override returns (uint8) {
        return tokenDecimals;
    }

    /// @notice Release part of the Agent-defined reserve to Agent-selected recipients.
    function releaseReserved(
        bytes32 releaseId,
        address[] calldata recipients,
        uint256[] calldata amountsRaw,
        uint64 worldMinute
    ) external {
        if (authorityModel != 1 || unallocatedSupplyHandling != 1) revert IssuerOnly();
        if (msg.sender != issuerWallet) revert IssuerOnly();
        if (releaseId == bytes32(0) || recipients.length == 0 || recipients.length != amountsRaw.length) {
            revert InvalidAllocation();
        }
        if (releasedReserveIds[releaseId]) revert InvalidIssuance();
        uint256 total;
        for (uint256 i; i < recipients.length; ++i) {
            if (recipients[i] == address(0) || amountsRaw[i] == 0) revert InvalidAllocation();
            total += amountsRaw[i];
        }
        if (total > reservedSupply) revert ReserveExceeded();

        releasedReserveIds[releaseId] = true;
        reservedSupply -= total;
        for (uint256 i; i < recipients.length; ++i) {
            _transfer(address(this), recipients[i], amountsRaw[i]);
        }
        emit ReserveReleased(worldId, issuanceId, releaseId, msg.sender, recipients, amountsRaw,
            reservedSupply, worldMinute);
    }
}
