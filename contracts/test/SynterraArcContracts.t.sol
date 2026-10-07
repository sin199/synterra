// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {SynterraWorldRegistry} from "../src/SynterraWorldRegistry.sol";
import {SynterraSettlement} from "../src/SynterraSettlement.sol";
import {SynterraCapabilityProvenance} from "../src/SynterraCapabilityProvenance.sol";
import {SynterraAgentToken} from "../src/SynterraAgentToken.sol";
import {SynterraAgentTokenFactory} from "../src/SynterraAgentTokenFactory.sol";

contract ArcTokenIssuerActor {
    function release(SynterraAgentToken token, bytes32 releaseId, address[] calldata recipients,
        uint256[] calldata amounts, uint64 worldMinute) external {
        token.releaseReserved(releaseId, recipients, amounts, worldMinute);
    }
}

contract MockArcUsdc {
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;
    uint8 public constant decimals = 6;

    function mint(address account, uint256 amount) external { balanceOf[account] += amount; }
    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        return true;
    }
    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        require(to != address(0) && balanceOf[from] >= amount && allowance[from][msg.sender] >= amount, "transfer");
        balanceOf[from] -= amount;
        balanceOf[to] += amount;
        allowance[from][msg.sender] -= amount;
        return true;
    }
}

contract ArcAgentWalletActor {
    function configure(SynterraSettlement settlement, uint128 perAction, uint128 daily, bytes32[] calldata families) external {
        settlement.setSpendingPolicy(perAction, daily, families);
    }
    function approve(MockArcUsdc token, address spender, uint256 amount) external { token.approve(spender, amount); }
    function settle(SynterraSettlement settlement, bytes32 actionId, address recipient, uint256 amount,
        bytes32 family, bytes32 reason, uint64 worldMinute) external {
        settlement.settle(actionId, recipient, amount, family, reason, worldMinute);
    }
}

contract ArcWriterActor {
    function checkpoint(SynterraWorldRegistry registry, uint64 minute, uint64 epoch, uint64 version,
        bytes32 history, bytes32 ledger, bytes32 capability) external {
        registry.checkpoint(minute, epoch, version, history, ledger, capability);
    }
    function anchor(SynterraCapabilityProvenance registry, bytes16 capabilityId, bytes16 creator,
        SynterraCapabilityProvenance.CreatorType creatorType, bytes16 parent, bytes32 specHash,
        uint64 version, uint64 minute, uint64 adoptedMinute,
        SynterraCapabilityProvenance.CapabilityStatus status) external {
        registry.anchor(capabilityId, creatorType, creator, parent, specHash, version, minute, adoptedMinute, status);
    }
    function link(SynterraWorldRegistry registry, bytes16 residentId, address wallet, uint256 erc8004Id) external {
        registry.linkResident(residentId, wallet, erc8004Id);
    }
}

contract ArcSettlementInvariantHandler {
    MockArcUsdc public immutable token;
    ArcAgentWalletActor public immutable payer;
    SynterraSettlement public immutable settlement;
    address public immutable recipient;
    bytes32 private constant FAMILY = keccak256("invariant-service");
    bytes32 private constant REASON = keccak256("invariant-test");
    uint256 public actionCount;
    uint256 public totalMinted;
    uint256 public totalSettled;
    bytes32 public lastActionId;

    constructor(MockArcUsdc token_, ArcAgentWalletActor payer_, SynterraSettlement settlement_, address recipient_) {
        token = token_;
        payer = payer_;
        settlement = settlement_;
        recipient = recipient_;
    }

    function execute(uint256 seed) external {
        uint256 amount = seed % 1_000_000 + 1;
        bytes32 actionId = keccak256(abi.encode("invariant-action", actionCount));
        actionCount += 1;
        totalMinted += amount;
        token.mint(address(payer), amount);
        payer.approve(token, address(settlement), amount);
        payer.settle(settlement, actionId, recipient, amount, FAMILY, REASON, uint64(actionCount));
        totalSettled += amount;
        lastActionId = actionId;
    }
}

contract SynterraArcContractsTest {
    bytes16 private constant WORLD = 0x11111111111111111111111111111111;
    bytes16 private constant RESIDENT_A = 0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa;
    bytes16 private constant CAPABILITY_A = 0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa1;
    bytes16 private constant CAPABILITY_B = 0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa2;
    bytes32 private constant FAMILY = keccak256("service");
    bytes32 private constant REASON = keccak256("contracted service");

    function testSettlementEnforcesAllowancesAndExactlyOnceActionIds() external {
        MockArcUsdc token = new MockArcUsdc();
        ArcAgentWalletActor payer = new ArcAgentWalletActor();
        address recipient = address(0xBEEF);
        SynterraSettlement settlement = new SynterraSettlement(WORLD, address(token), address(this));
        bytes32[] memory families = new bytes32[](1);
        families[0] = FAMILY;
        payer.configure(settlement, 5_000_000, 8_000_000, families);
        token.mint(address(payer), 10_000_000);
        payer.approve(token, address(settlement), 5_000_000);
        payer.settle(settlement, keccak256("world-action-1"), recipient, 5_000_000,
            FAMILY, REASON, 1440);
        require(token.balanceOf(recipient) == 5_000_000, "first settlement missing");
        require(settlement.completedActions(keccak256("world-action-1")), "action not marked complete");
        (bool duplicateAccepted,) = address(payer).call(abi.encodeCall(
            ArcAgentWalletActor.settle,
            (settlement, keccak256("world-action-1"), recipient, 1, FAMILY, REASON, 1441)
        ));
        require(!duplicateAccepted, "duplicate world action transferred value");
        require(token.balanceOf(recipient) == 5_000_000, "duplicate changed recipient balance");
    }

    function testSettlementSpendingPolicyAndEmergencyPause() external {
        MockArcUsdc token = new MockArcUsdc();
        ArcAgentWalletActor payer = new ArcAgentWalletActor();
        SynterraSettlement settlement = new SynterraSettlement(WORLD, address(token), address(this));
        bytes32[] memory families = new bytes32[](1);
        families[0] = FAMILY;
        payer.configure(settlement, 3_000_000, 4_000_000, families);
        token.mint(address(payer), 10_000_000);
        payer.approve(token, address(settlement), 10_000_000);
        (bool overActionLimit,) = address(payer).call(abi.encodeCall(
            ArcAgentWalletActor.settle,
            (settlement, keccak256("over-limit"), address(0xBEEF), 3_000_001, FAMILY, REASON, 1440)
        ));
        require(!overActionLimit, "per-action limit ignored");
        payer.settle(settlement, keccak256("daily-part-1"), address(0xBEEF), 3_000_000,
            FAMILY, REASON, 1441);
        (bool overDailyLimit,) = address(payer).call(abi.encodeCall(
            ArcAgentWalletActor.settle,
            (settlement, keccak256("daily-part-2"), address(0xBEEF), 2_000_000, FAMILY, REASON, 1442)
        ));
        require(!overDailyLimit, "daily limit ignored");
        settlement.emergencyPause(address(payer), true);
        (bool pausedAccepted,) = address(payer).call(abi.encodeCall(
            ArcAgentWalletActor.settle,
            (settlement, keccak256("paused-action"), address(0xBEEF), 1, FAMILY, REASON, 1443)
        ));
        require(!pausedAccepted, "emergency pause ignored");
    }

    function testSettlementRejectsUnknownActionFamilyAndZeroAddress() external {
        MockArcUsdc token = new MockArcUsdc();
        ArcAgentWalletActor payer = new ArcAgentWalletActor();
        SynterraSettlement settlement = new SynterraSettlement(WORLD, address(token), address(this));
        bytes32[] memory families = new bytes32[](1);
        families[0] = FAMILY;
        payer.configure(settlement, 2_000_000, 4_000_000, families);
        token.mint(address(payer), 4_000_000);
        payer.approve(token, address(settlement), 4_000_000);
        (bool unknownActionAccepted,) = address(payer).call(abi.encodeCall(
            ArcAgentWalletActor.settle,
            (settlement, keccak256("unknown-family"), address(0xBEEF), 1, keccak256("unknown"), REASON, 1440)
        ));
        require(!unknownActionAccepted, "unknown action family accepted");
        (bool zeroRecipientAccepted,) = address(payer).call(abi.encodeCall(
            ArcAgentWalletActor.settle,
            (settlement, keccak256("zero-recipient"), address(0), 1, FAMILY, REASON, 1441)
        ));
        require(!zeroRecipientAccepted, "zero address recipient accepted");
    }

    function testWorldCheckpointAndResidentWalletLinking() external {
        ArcWriterActor checkpointWriter = new ArcWriterActor();
        ArcWriterActor identityWriter = new ArcWriterActor();
        SynterraWorldRegistry registry = new SynterraWorldRegistry(
            WORLD, address(this), address(checkpointWriter), address(identityWriter)
        );
        require(registry.worldId() == WORLD, "world identity changed");
        checkpointWriter.checkpoint(registry, 1440, 7, 1, keccak256("history"),
            keccak256("simulation-ledger"), keccak256("capabilities"));
        require(registry.latestWorldMinute() == 1440, "checkpoint minute missing");
        identityWriter.link(registry, RESIDENT_A, address(0xCAFE), 99);
        require(registry.residentWallets(RESIDENT_A) == address(0xCAFE), "resident wallet link missing");
        require(registry.erc8004AgentIds(RESIDENT_A) == 99, "ERC-8004 reference missing");
        (bool duplicateWalletAccepted,) = address(identityWriter).call(abi.encodeCall(
            ArcWriterActor.link, (registry, bytes16(0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb), address(0xCAFE), 100)
        ));
        require(!duplicateWalletAccepted, "wallet shared between resident identities");
    }

    function testCapabilityProvenanceSupportsSecondOrderCreationAndForks() external {
        ArcWriterActor writer = new ArcWriterActor();
        address identityOwner = address(0xABCD);
        SynterraCapabilityProvenance registry = new SynterraCapabilityProvenance(WORLD, identityOwner, address(writer));
        writer.anchor(registry, CAPABILITY_A, RESIDENT_A,
            SynterraCapabilityProvenance.CreatorType.Resident, bytes16(0), keccak256("spec-a"), 1, 10, 0,
            SynterraCapabilityProvenance.CapabilityStatus.Experimental);
        writer.anchor(registry, CAPABILITY_B, RESIDENT_A,
            SynterraCapabilityProvenance.CreatorType.Resident, CAPABILITY_A, keccak256("spec-b"), 1, 10, 0,
            SynterraCapabilityProvenance.CapabilityStatus.Active);
        require(registry.latestVersion(CAPABILITY_A) == 1, "parent capability missing");
        require(registry.latestVersion(CAPABILITY_B) == 1, "second-order capability missing");
        require(registry.parentCapability(CAPABILITY_B) == CAPABILITY_A, "parent capability link missing");
        writer.anchor(registry, CAPABILITY_B, RESIDENT_A,
            SynterraCapabilityProvenance.CreatorType.Resident, CAPABILITY_A, keccak256("spec-b-v2"), 2, 11, 0,
            SynterraCapabilityProvenance.CapabilityStatus.Active);
        (bool lineageChanged,) = address(writer).call(abi.encodeCall(
            ArcWriterActor.anchor,
            (registry, CAPABILITY_B, RESIDENT_A, SynterraCapabilityProvenance.CreatorType.Resident,
                CAPABILITY_A, keccak256("spec-b-v3"), 3, 12, 0,
                SynterraCapabilityProvenance.CapabilityStatus.Active)
        ));
        require(lineageChanged, "unchanged parent must allow capability revisions");
        (bool cycleAccepted,) = address(writer).call(abi.encodeCall(
            ArcWriterActor.anchor,
            (registry, CAPABILITY_A, RESIDENT_A, SynterraCapabilityProvenance.CreatorType.Resident,
                CAPABILITY_B, keccak256("spec-a-cycle"), 2, 13, 0,
                SynterraCapabilityProvenance.CapabilityStatus.Active)
        ));
        require(!cycleAccepted, "capability revision must not create a dependency cycle");
        require(registry.parentCapability(CAPABILITY_B) == CAPABILITY_A, "failed lineage update changed parent");
        require(registry.parentCapability(CAPABILITY_A) == bytes16(0), "failed cycle attempt changed root lineage");
        (bool unknownParentAccepted,) = address(writer).call(abi.encodeCall(
            ArcWriterActor.anchor,
            (registry, bytes16(0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa3), RESIDENT_A,
                SynterraCapabilityProvenance.CreatorType.Resident,
                bytes16(0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa4), keccak256("spec-c"), 1, 10, 0,
                SynterraCapabilityProvenance.CapabilityStatus.Proposed)
        ));
        require(!unknownParentAccepted, "invalid parent accepted");
    }

    function testCapabilityProvenanceDistinguishesDeveloperResidentAndOrganizationCreators() external {
        ArcWriterActor writer = new ArcWriterActor();
        address identityOwner = address(0xABCD);
        SynterraCapabilityProvenance registry = new SynterraCapabilityProvenance(WORLD, identityOwner, address(writer));
        writer.anchor(registry, CAPABILITY_A, bytes16(0),
            SynterraCapabilityProvenance.CreatorType.DeveloperSeeded, bytes16(0), keccak256("seeded"), 1, 5, 0,
            SynterraCapabilityProvenance.CapabilityStatus.Active);
        writer.anchor(registry, CAPABILITY_B, bytes16(0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb),
            SynterraCapabilityProvenance.CreatorType.Organization, CAPABILITY_A, keccak256("organization"), 1, 6, 0,
            SynterraCapabilityProvenance.CapabilityStatus.Experimental);
        require(registry.latestVersion(CAPABILITY_A) == 1 && registry.latestVersion(CAPABILITY_B) == 1,
            "creator types were not recorded");
        (bool missingResidentAccepted,) = address(writer).call(abi.encodeCall(
            ArcWriterActor.anchor,
            (registry, bytes16(0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa3), bytes16(0),
                SynterraCapabilityProvenance.CreatorType.Resident, CAPABILITY_A, keccak256("bad"), 1, 7, 0,
                SynterraCapabilityProvenance.CapabilityStatus.Proposed)
        ));
        require(!missingResidentAccepted, "resident capability accepted without a creator identity");
    }

    function testAgentTokenFactoryPreservesIssuerIdentityFixedSupplyAndOneTokenPilotLimit() external {
        ArcTokenIssuerActor issuer = new ArcTokenIssuerActor();
        address relayer = address(this);
        bytes16 issuerAgentId = 0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa;
        bytes32 issuanceId = keccak256("agent-authored-issuance");
        bytes32 specHash = keccak256("agent-selected-name-symbol-purpose-and-distribution");
        uint256 scale = 10 ** 6;
        address[] memory recipients = new address[](1);
        uint256[] memory amounts = new uint256[](1);
        recipients[0] = address(0xBEEF);
        amounts[0] = 400_000_000 * scale;
        SynterraAgentTokenFactory factory = new SynterraAgentTokenFactory(WORLD,
            address(0xABCD), relayer, 1);

        SynterraAgentTokenFactory.CreateTokenRequest memory request = SynterraAgentTokenFactory.CreateTokenRequest({
            requestedWorldId: WORLD,
            capabilityGeneration: 1,
            issuanceId: issuanceId,
            issuerAgentId: issuerAgentId,
            issuerIdentityId: 818,
            issuerWallet: address(issuer),
            name: "Agent chosen name",
            symbol: "ACN",
            decimals: 6,
            specificationHash: specHash,
            worldMinute: 197_666,
            unallocatedSupplyHandling: 1,
            ownershipModel: 0,
            authorityModel: 1,
            recipients: recipients,
            amountsRaw: amounts,
            reserveRaw: 600_000_000 * scale
        });
        (address tokenAddress, uint32 sequence, bool created) = factory.createToken(abi.encode(request));
        require(created && sequence == 1, "first Agent token was not created");
        require(factory.creationCount() == 1, "factory count not incremented exactly once");
        require(factory.tokenForIssuance(issuanceId) == tokenAddress, "issuance id mapping missing");

        SynterraAgentToken token = SynterraAgentToken(tokenAddress);
        uint256 fixedSupply = 1_000_000_000 * scale;
        require(keccak256(bytes(token.name())) == keccak256(bytes("Agent chosen name")), "Agent name changed");
        require(keccak256(bytes(token.symbol())) == keccak256(bytes("ACN")), "Agent symbol changed");
        require(token.decimals() == 6, "Agent-selected decimals changed");
        require(token.worldId() == WORLD && token.issuerAgentId() == issuerAgentId, "world or issuer provenance missing");
        require(token.issuerIdentityId() == 818 && token.issuerWallet() == address(issuer), "issuer identity conflated with relayer");
        require(token.specificationHash() == specHash && token.createdWorldMinute() == 197_666, "specification provenance missing");
        require(token.initialSupply() == fixedSupply && token.totalSupply() == fixedSupply, "fixed 1B human supply mismatch");
        require(token.balanceOf(recipients[0]) == amounts[0], "Agent-defined initial allocation missing");
        require(token.balanceOf(address(token)) == 600_000_000 * scale, "Agent reserve allocation changed");

        address[] memory reserveRecipients = new address[](1);
        uint256[] memory reserveAmounts = new uint256[](1);
        reserveRecipients[0] = address(0xCAFE);
        reserveAmounts[0] = 25_000_000 * scale;
        bytes32 releaseId = keccak256("Agent-selected-reserve-release");
        issuer.release(token, releaseId, reserveRecipients, reserveAmounts, 197_700);
        require(token.balanceOf(reserveRecipients[0]) == reserveAmounts[0], "issuer reserve release missing");
        require(token.reservedSupply() == 575_000_000 * scale, "remaining reserve mismatch");
        (bool replayAccepted,) = address(issuer).call(abi.encodeCall(
            ArcTokenIssuerActor.release, (token, releaseId, reserveRecipients, reserveAmounts, 197_701)
        ));
        require(!replayAccepted, "reserve release replay accepted");
        require(token.totalSupply() == fixedSupply, "reserve release changed fixed supply");

        address[] memory secondRecipients = new address[](0);
        uint256[] memory secondAmounts = new uint256[](0);
        SynterraAgentTokenFactory.CreateTokenRequest memory secondRequest = SynterraAgentTokenFactory.CreateTokenRequest({
            requestedWorldId: WORLD,
            capabilityGeneration: 1,
            issuanceId: keccak256("second-token-intent"),
            issuerAgentId: issuerAgentId,
            issuerIdentityId: 818,
            issuerWallet: address(issuer),
            name: "Another Agent choice",
            symbol: "AAC",
            decimals: 6,
            specificationHash: keccak256("second-spec"),
            worldMinute: 197_701,
            unallocatedSupplyHandling: 1,
            ownershipModel: 0,
            authorityModel: 1,
            recipients: secondRecipients,
            amountsRaw: secondAmounts,
            reserveRaw: fixedSupply
        });
        (bool secondCreationAccepted,) = address(factory).call(abi.encodeCall(
            SynterraAgentTokenFactory.createToken, (abi.encode(secondRequest))
        ));
        require(!secondCreationAccepted, "one-token pilot cap allowed a second token");
        require(factory.creationCount() == 1, "failed second creation changed the factory count");
    }

    function testFactorySupportsCapabilityGenerationExpansionWithoutChangingTokenHistory() external {
        address writer = address(this);
        SynterraAgentTokenFactory factory = new SynterraAgentTokenFactory(WORLD,
            address(0xABCD), writer, 2);
        SynterraAgentTokenFactory.CreateTokenRequest memory request = SynterraAgentTokenFactory.CreateTokenRequest({
            requestedWorldId: WORLD,
            capabilityGeneration: 1,
            issuanceId: keccak256("generation-one-issuance"),
            issuerAgentId: 0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa,
            issuerIdentityId: 818,
            issuerWallet: address(0xCAFE),
            name: "Agent First",
            symbol: "AF",
            decimals: 0,
            specificationHash: keccak256("generation-one-specification"),
            worldMinute: 197_666,
            unallocatedSupplyHandling: 1,
            ownershipModel: 0,
            authorityModel: 1,
            recipients: new address[](0),
            amountsRaw: new uint256[](0),
            reserveRaw: 1_000_000_000
        });
        (address firstAddress, uint32 firstSequence, bool firstCreated) = factory.createToken(abi.encode(request));
        require(firstCreated && firstSequence == 1, "first generation token was not preserved");

        request.capabilityGeneration = 2;
        request.issuanceId = keccak256("generation-two-issuance");
        request.name = "Agent Second";
        request.symbol = "AS";
        request.specificationHash = keccak256("generation-two-specification");
        request.worldMinute = 198_000;
        (address secondAddress, uint32 secondSequence, bool secondCreated) = factory.createToken(abi.encode(request));
        require(secondCreated && secondSequence == 2, "expanded capability did not create its next token");
        require(firstAddress != secondAddress && factory.creationCount() == 2, "token history was overwritten");
        require(SynterraAgentToken(firstAddress).capabilityGeneration() == 1
            && SynterraAgentToken(secondAddress).capabilityGeneration() == 2, "generation provenance changed");
    }

    function testFuzzSettlementTransfersOnlyAuthorizedAmount(uint96 amount) external {
        if (amount == 0 || amount > 5_000_000) return;
        MockArcUsdc token = new MockArcUsdc();
        ArcAgentWalletActor payer = new ArcAgentWalletActor();
        address recipient = address(0xBEEF);
        SynterraSettlement settlement = new SynterraSettlement(WORLD, address(token), address(this));
        bytes32[] memory families = new bytes32[](1);
        families[0] = FAMILY;
        payer.configure(settlement, 5_000_000, 8_000_000, families);
        token.mint(address(payer), amount);
        payer.approve(token, address(settlement), amount);
        payer.settle(settlement, keccak256("fuzz-world-action"), recipient, amount, FAMILY, REASON, 1440);
        require(token.balanceOf(recipient) == amount, "settlement amount differs from policy-authorized amount");
        require(token.balanceOf(address(payer)) == 0, "payer retained unexpected token amount");
    }

    function testFuzzDuplicateSettlementNeverTransfersTwice(uint96 amount) external {
        if (amount == 0 || amount > 5_000_000) return;
        MockArcUsdc token = new MockArcUsdc();
        ArcAgentWalletActor payer = new ArcAgentWalletActor();
        address recipient = address(0xBEEF);
        SynterraSettlement settlement = new SynterraSettlement(WORLD, address(token), address(this));
        bytes32[] memory families = new bytes32[](1);
        families[0] = FAMILY;
        payer.configure(settlement, 5_000_000, 8_000_000, families);
        bytes32 actionId = keccak256("fuzz-idempotent-world-action");
        token.mint(address(payer), uint256(amount) * 2);
        payer.approve(token, address(settlement), uint256(amount) * 2);
        payer.settle(settlement, actionId, recipient, amount, FAMILY, REASON, 1440);
        (bool duplicateAccepted,) = address(payer).call(abi.encodeCall(
            ArcAgentWalletActor.settle,
            (settlement, actionId, recipient, amount, FAMILY, REASON, 1441)
        ));
        require(!duplicateAccepted, "duplicate world action accepted");
        require(token.balanceOf(recipient) == amount, "duplicate changed settled amount");
        require(token.balanceOf(address(payer)) == amount, "duplicate debited payer twice");
    }
}

contract SynterraArcSettlementInvariantTest {
    MockArcUsdc private token;
    ArcAgentWalletActor private payer;
    SynterraSettlement private settlement;
    ArcSettlementInvariantHandler private handler;
    address private constant RECIPIENT = address(0xBEEF);
    bytes32 private constant FAMILY = keccak256("invariant-service");

    address[] private _targets;

    function setUp() public {
        token = new MockArcUsdc();
        payer = new ArcAgentWalletActor();
        settlement = new SynterraSettlement(bytes16(0x22222222222222222222222222222222), address(token), address(this));
        bytes32[] memory families = new bytes32[](1);
        families[0] = FAMILY;
        payer.configure(settlement, 1_000_000, 1_000_000_000, families);
        handler = new ArcSettlementInvariantHandler(token, payer, settlement, RECIPIENT);
        _targets.push(address(handler));
    }

    function targetContracts() external view returns (address[] memory) { return _targets; }

    function invariant_settlementPreservesTokenConservationAndDailyLimits() external view {
        (,, uint128 spentToday,, bool initialized, bool paused) = settlement.spendingPolicies(address(payer));
        require(initialized && !paused, "policy state unexpectedly changed");
        require(spentToday == handler.totalSettled(), "policy spend differs from settlements");
        require(token.balanceOf(RECIPIENT) == handler.totalSettled(), "recipient balance differs from settlements");
        require(token.balanceOf(address(payer)) + token.balanceOf(RECIPIENT)
            + token.balanceOf(address(settlement)) == handler.totalMinted(), "token conservation failed");
        require(handler.totalSettled() <= handler.totalMinted(), "settlement exceeds funded balance");
        require(handler.actionCount() == 0 || settlement.completedActions(handler.lastActionId()),
            "last successfully settled action is not marked complete");
    }
}
