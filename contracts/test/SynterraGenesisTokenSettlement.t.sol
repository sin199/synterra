// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {SynterraGenesisTokenSettlement} from "../src/SynterraGenesisTokenSettlement.sol";

contract MockGenesisToken {
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    function mint(address account, uint256 amount) external { balanceOf[account] += amount; }
    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        return true;
    }
    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        require(balanceOf[from] >= amount && allowance[from][msg.sender] >= amount, "transfer");
        balanceOf[from] -= amount;
        balanceOf[to] += amount;
        allowance[from][msg.sender] -= amount;
        return true;
    }
}

contract GenesisAgentWalletActor {
    function configure(SynterraGenesisTokenSettlement settlement, uint128 perAction,
        uint128 daily, bytes32[] calldata families) external {
        settlement.setSpendingPolicy(perAction, daily, families);
    }
    function approve(MockGenesisToken token, address spender, uint256 amount) external {
        token.approve(spender, amount);
    }
    function settle(SynterraGenesisTokenSettlement settlement, bytes32 actionId, address recipient,
        uint256 amount, bytes32 family, bytes32 reason, uint64 worldMinute) external {
        settlement.settle(actionId, recipient, amount, family, reason, worldMinute);
    }
}

contract SynterraGenesisTokenSettlementTest {
    bytes16 private constant WORLD = 0x11111111111111111111111111111111;
    bytes32 private constant FAMILY = keccak256("business_service_payment");
    bytes32 private constant REASON = keccak256("agent selected service");

    function testSettlementTransfersOnlyWithPayerWalletApprovalAndNeverCustodiesTokens() external {
        MockGenesisToken token = new MockGenesisToken();
        GenesisAgentWalletActor payer = new GenesisAgentWalletActor();
        address recipient = address(0xBEEF);
        SynterraGenesisTokenSettlement settlement = new SynterraGenesisTokenSettlement(
            WORLD, address(token), address(this));
        bytes32[] memory families = new bytes32[](1);
        families[0] = FAMILY;
        payer.configure(settlement, 500, 1_000, families);
        token.mint(address(payer), 1_000);

        (bool withoutApproval,) = address(payer).call(abi.encodeCall(
            GenesisAgentWalletActor.settle,
            (settlement, keccak256("action-1"), recipient, 100, FAMILY, REASON, 42)
        ));
        require(!withoutApproval, "settlement bypassed payer token approval");
        require(token.balanceOf(address(payer)) == 1_000, "failed settlement debited payer");
        require(token.balanceOf(recipient) == 0, "failed settlement credited recipient");

        payer.approve(token, address(settlement), 100);
        payer.settle(settlement, keccak256("action-1"), recipient, 100, FAMILY, REASON, 42);
        require(token.balanceOf(address(payer)) == 900, "payer debit missing");
        require(token.balanceOf(recipient) == 100, "recipient credit missing");
        require(token.balanceOf(address(settlement)) == 0, "settlement contract took custody");
        require(token.allowance(address(payer), address(settlement)) == 0, "allowance was not exact");
    }

    function testWalletPolicyBoundsSettlementAndPreventsDuplicateActions() external {
        MockGenesisToken token = new MockGenesisToken();
        GenesisAgentWalletActor payer = new GenesisAgentWalletActor();
        address recipient = address(0xBEEF);
        SynterraGenesisTokenSettlement settlement = new SynterraGenesisTokenSettlement(
            WORLD, address(token), address(this));
        bytes32[] memory families = new bytes32[](1);
        families[0] = FAMILY;
        payer.configure(settlement, 400, 500, families);
        token.mint(address(payer), 1_000);
        payer.approve(token, address(settlement), 1_000);

        (bool perActionExceeded,) = address(payer).call(abi.encodeCall(
            GenesisAgentWalletActor.settle,
            (settlement, keccak256("action-over-limit"), recipient, 401, FAMILY, REASON, 42)
        ));
        require(!perActionExceeded, "per-action limit ignored");

        payer.settle(settlement, keccak256("action-1"), recipient, 400, FAMILY, REASON, 42);
        (bool dailyExceeded,) = address(payer).call(abi.encodeCall(
            GenesisAgentWalletActor.settle,
            (settlement, keccak256("action-2"), recipient, 101, FAMILY, REASON, 43)
        ));
        require(!dailyExceeded, "daily limit ignored");
        (bool duplicateAccepted,) = address(payer).call(abi.encodeCall(
            GenesisAgentWalletActor.settle,
            (settlement, keccak256("action-1"), recipient, 1, FAMILY, REASON, 44)
        ));
        require(!duplicateAccepted, "duplicate action accepted");
        require(token.balanceOf(recipient) == 400, "rejected actions changed recipient balance");
    }

    function testOnlyConfiguredActionFamilyCanSpend() external {
        MockGenesisToken token = new MockGenesisToken();
        GenesisAgentWalletActor payer = new GenesisAgentWalletActor();
        SynterraGenesisTokenSettlement settlement = new SynterraGenesisTokenSettlement(
            WORLD, address(token), address(this));
        bytes32[] memory families = new bytes32[](1);
        families[0] = FAMILY;
        payer.configure(settlement, 100, 100, families);
        token.mint(address(payer), 100);
        payer.approve(token, address(settlement), 100);
        (bool unknownFamilyAccepted,) = address(payer).call(abi.encodeCall(
            GenesisAgentWalletActor.settle,
            (settlement, keccak256("unknown-family"), address(0xBEEF), 1,
                keccak256("unknown_family"), REASON, 42)
        ));
        require(!unknownFamilyAccepted, "unconfigured action family accepted");
        require(token.balanceOf(address(payer)) == 100, "unconfigured action family debited payer");
    }
}
