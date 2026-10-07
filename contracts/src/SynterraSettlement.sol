// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

interface IERC20Arc {
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
}

contract SynterraSettlement {
    error Unauthorized();
    error InvalidAddress();
    error InvalidAmount();
    error DuplicateAction();
    error PolicyMissing();
    error PolicyPaused();
    error ActionFamilyNotAllowed();
    error PerActionLimitExceeded();
    error DailyLimitExceeded();
    error TokenTransferFailed();
    error ReentrantCall();

    struct SpendingPolicy {
        uint128 perActionLimit;
        uint128 dailyLimit;
        uint128 spentToday;
        uint64 dayIndex;
        bool initialized;
        bool paused;
    }

    bytes16 public immutable worldId;
    IERC20Arc public immutable usdc;
    address public immutable emergencyOperator;
    mapping(address agentWallet => SpendingPolicy policy) public spendingPolicies;
    mapping(address agentWallet => mapping(bytes32 actionFamilyHash => bool allowed)) public allowedActionFamilies;
    mapping(address agentWallet => bytes32[] actionFamilyList) private actionFamilyLists;
    mapping(bytes32 worldActionId => bool completed) public completedActions;
    uint256 private entered;

    event SpendingPolicyChanged(address indexed agentWallet, uint128 perActionLimit,
        uint128 dailyLimit, uint64 policyDay);
    event EmergencyPauseChanged(address indexed agentWallet, bool paused);
    event Settlement(bytes16 indexed worldId, bytes32 indexed worldActionId, address indexed payer,
        address recipient, uint256 amount, bytes32 actionFamilyHash, bytes32 reasonHash, uint64 createdWorldMinute);

    constructor(bytes16 worldId_, address usdc_, address emergencyOperator_) {
        if (worldId_ == bytes16(0) || usdc_ == address(0) || emergencyOperator_ == address(0)) revert InvalidAddress();
        worldId = worldId_;
        usdc = IERC20Arc(usdc_);
        emergencyOperator = emergencyOperator_;
    }

    modifier nonReentrant() {
        if (entered != 0) revert ReentrantCall();
        entered = 1;
        _;
        entered = 0;
    }

    function setSpendingPolicy(uint128 perActionLimit, uint128 dailyLimit,
        bytes32[] calldata actionFamilies) external {
        if (msg.sender == address(0) || dailyLimit < perActionLimit || actionFamilies.length > 16
            || ((perActionLimit == 0 || dailyLimit == 0) && (perActionLimit != 0 || dailyLimit != 0))
            || (perActionLimit == 0 && actionFamilies.length != 0)
            || (perActionLimit > 0 && actionFamilies.length == 0)) revert InvalidAmount();
        SpendingPolicy storage policy = spendingPolicies[msg.sender];
        policy.perActionLimit = perActionLimit;
        policy.dailyLimit = dailyLimit;
        policy.initialized = true;
        uint64 today = uint64(block.timestamp / 1 days);
        if (policy.dayIndex != today) {
            policy.dayIndex = today;
            policy.spentToday = 0;
        }
        bytes32[] storage previousFamilies = actionFamilyLists[msg.sender];
        for (uint256 i; i < previousFamilies.length; ++i) {
            delete allowedActionFamilies[msg.sender][previousFamilies[i]];
        }
        delete actionFamilyLists[msg.sender];
        for (uint256 i; i < actionFamilies.length; ++i) {
            if (actionFamilies[i] == bytes32(0) || allowedActionFamilies[msg.sender][actionFamilies[i]]) {
                revert ActionFamilyNotAllowed();
            }
            allowedActionFamilies[msg.sender][actionFamilies[i]] = true;
            actionFamilyLists[msg.sender].push(actionFamilies[i]);
        }
        emit SpendingPolicyChanged(msg.sender, perActionLimit, dailyLimit, today);
    }

    function actionFamilyCount(address agentWallet) external view returns (uint256) {
        return actionFamilyLists[agentWallet].length;
    }

    function emergencyPause(address agentWallet, bool paused) external {
        if (msg.sender != emergencyOperator) revert Unauthorized();
        if (agentWallet == address(0)) revert InvalidAddress();
        spendingPolicies[agentWallet].paused = paused;
        emit EmergencyPauseChanged(agentWallet, paused);
    }

    function settle(bytes32 worldActionId, address recipient, uint256 amount,
        bytes32 actionFamilyHash, bytes32 reasonHash, uint64 createdWorldMinute) external nonReentrant {
        if (recipient == address(0) || recipient == msg.sender) revert InvalidAddress();
        if (worldActionId == bytes32(0) || actionFamilyHash == bytes32(0) || reasonHash == bytes32(0)
            || createdWorldMinute == 0 || amount == 0 || amount > type(uint128).max) revert InvalidAmount();
        if (completedActions[worldActionId]) revert DuplicateAction();
        SpendingPolicy storage policy = spendingPolicies[msg.sender];
        if (!policy.initialized) revert PolicyMissing();
        if (policy.paused) revert PolicyPaused();
        if (!allowedActionFamilies[msg.sender][actionFamilyHash]) revert ActionFamilyNotAllowed();
        if (amount > policy.perActionLimit) revert PerActionLimitExceeded();
        uint64 today = uint64(block.timestamp / 1 days);
        if (policy.dayIndex != today) {
            policy.dayIndex = today;
            policy.spentToday = 0;
        }
        uint256 nextSpent = uint256(policy.spentToday) + amount;
        if (nextSpent > policy.dailyLimit) revert DailyLimitExceeded();

        completedActions[worldActionId] = true;
        policy.spentToday = uint128(nextSpent);
        (bool success, bytes memory data) = address(usdc).call(
            abi.encodeCall(IERC20Arc.transferFrom, (msg.sender, recipient, amount))
        );
        if (!success || (data.length != 0 && !abi.decode(data, (bool)))) revert TokenTransferFailed();
        emit Settlement(worldId, worldActionId, msg.sender, recipient, amount,
            actionFamilyHash, reasonHash, createdWorldMinute);
    }
}
