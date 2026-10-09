// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

interface IERC20GenesisSettlement {
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
}

/// @notice A non-custodial settlement primitive for one world's Genesis ERC-20.
/// @dev The payer is always msg.sender. The contract never holds a user balance;
///      it can transfer only the amount that the payer approved and authorized by
///      calling settle from its own Agent wallet. Approval can be revoked by that wallet.
contract SynterraGenesisTokenSettlement {
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
    IERC20GenesisSettlement public immutable token;
    address public immutable emergencyOperator;
    mapping(address agentWallet => SpendingPolicy policy) public spendingPolicies;
    mapping(address agentWallet => mapping(bytes32 actionFamilyHash => bool allowed)) public allowedActionFamilies;
    mapping(address agentWallet => bytes32[] actionFamilyList) private actionFamilyLists;
    mapping(bytes32 worldActionId => bool completed) public completedActions;
    uint256 private entered;

    event SpendingPolicyChanged(address indexed agentWallet, uint128 perActionLimit,
        uint128 dailyLimit, uint64 policyDay);
    event EmergencyPauseChanged(address indexed agentWallet, bool paused);
    event TokenSettlement(bytes16 indexed worldId, address indexed token, bytes32 indexed worldActionId,
        address payer, address recipient, uint256 amountRaw, bytes32 actionFamilyHash,
        bytes32 reasonHash, uint64 createdWorldMinute);

    constructor(bytes16 worldId_, address token_, address emergencyOperator_) {
        if (worldId_ == bytes16(0) || token_ == address(0) || emergencyOperator_ == address(0)) revert InvalidAddress();
        worldId = worldId_;
        token = IERC20GenesisSettlement(token_);
        emergencyOperator = emergencyOperator_;
    }

    modifier nonReentrant() {
        if (entered != 0) revert ReentrantCall();
        entered = 1;
        _;
        entered = 0;
    }

    /// @notice Configure the caller wallet's own bounded action policy.
    function setSpendingPolicy(uint128 perActionLimit, uint128 dailyLimit,
        bytes32[] calldata actionFamilies) external {
        if (dailyLimit < perActionLimit || actionFamilies.length > 16
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
        for (uint256 i; i < previousFamilies.length; ++i) delete allowedActionFamilies[msg.sender][previousFamilies[i]];
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

    /// @notice Move actual Genesis Token directly between wallets after payer-wallet authorization.
    /// @dev The transaction caller must be the payer wallet, which must also have approved this
    ///      contract for at least `amountRaw`. No token is retained by this contract.
    function settle(bytes32 worldActionId, address recipient, uint256 amountRaw,
        bytes32 actionFamilyHash, bytes32 reasonHash, uint64 createdWorldMinute) external nonReentrant {
        if (recipient == address(0) || recipient == msg.sender) revert InvalidAddress();
        if (worldActionId == bytes32(0) || actionFamilyHash == bytes32(0) || reasonHash == bytes32(0)
            || createdWorldMinute == 0 || amountRaw == 0 || amountRaw > type(uint128).max) revert InvalidAmount();
        if (completedActions[worldActionId]) revert DuplicateAction();
        SpendingPolicy storage policy = spendingPolicies[msg.sender];
        if (!policy.initialized) revert PolicyMissing();
        if (policy.paused) revert PolicyPaused();
        if (!allowedActionFamilies[msg.sender][actionFamilyHash]) revert ActionFamilyNotAllowed();
        if (amountRaw > policy.perActionLimit) revert PerActionLimitExceeded();
        uint64 today = uint64(block.timestamp / 1 days);
        if (policy.dayIndex != today) {
            policy.dayIndex = today;
            policy.spentToday = 0;
        }
        uint256 nextSpent = uint256(policy.spentToday) + amountRaw;
        if (nextSpent > policy.dailyLimit) revert DailyLimitExceeded();

        completedActions[worldActionId] = true;
        policy.spentToday = uint128(nextSpent);
        if (!token.transferFrom(msg.sender, recipient, amountRaw)) revert TokenTransferFailed();
        emit TokenSettlement(worldId, address(token), worldActionId, msg.sender, recipient,
            amountRaw, actionFamilyHash, reasonHash, createdWorldMinute);
    }
}
