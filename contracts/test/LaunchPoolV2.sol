// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import "../LaunchPool.sol";
import "../LaunchPoolFactoryUpgradeable.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

contract LaunchPoolV2 is LaunchPool {
    using SafeERC20 for IERC20;

    // New features for V2
    uint256 public maxParticipants;  // Maximum number of participants
    uint256 public participantCount;  // Current number of participants
    mapping(address => bool) public hasParticipated;  // Track unique participants

    event NewParticipant(address indexed user);  // New event for V2

    function initialize(
        IERC20 _stakedToken,
        uint256 _poolRewardAmount,
        uint256 _poolLimitPerUser,
        uint256 _minStakeAmount,
        uint256 _projectId,
        uint256 _maxParticipants  // New parameter for V2
    ) external virtual {
        require(!isInitialized, "Already initialized");
        require(msg.sender == LAUNCH_POOL_FACTORY, "Not factory");
        require(_maxParticipants > 0, "Invalid max participants");  // V2 validation

        isInitialized = true;
        projectId = _projectId;
        stakedToken = _stakedToken;
        poolRewardAmount = _poolRewardAmount;
        minStakeAmount = _minStakeAmount;

        if (_poolLimitPerUser > 0) {
            hasUserLimit = true;
            poolLimitPerUser = _poolLimitPerUser;
        }

        // Calculate reward per second using factory
        rewardPerSecond = factory.calculateRewardPerSecond(projectId, _poolRewardAmount);

        // Set up precision factor
        uint256 decimalsRewardToken = IERC20Metadata(address(rewardToken())).decimals();
        require(decimalsRewardToken < 30, "Must be inferior to 30");
        PRECISION_FACTOR = 10**(uint256(30) - decimalsRewardToken);

        // Set last reward time to project start time
        (uint256 startTime,) = getProjectTimes();
        lastRewardTime = startTime;

        // V2 initialization
        maxParticipants = _maxParticipants;
    }

    // Override deposit to track participants
    function deposit(uint256 _amount) external override nonReentrant {
        require(participantCount < maxParticipants, "Max participants reached");
        
        UserInfo storage user = userInfo[msg.sender];
        bytes32 statusHash = keccak256(bytes(factory.getProjectStatus(projectId)));
        require(statusHash == ACTIVE, "Pool not active");

        if (_amount > 0) {
            require(_amount >= minStakeAmount, "Amount below minimum stake");
            if (hasUserLimit) {
                require(_amount + user.amount <= poolLimitPerUser, "User amount above limit");
            }
        }

        _updatePool();

        if (user.amount > 0) {
            uint256 pending = user.amount * accTokenPerShare / PRECISION_FACTOR - user.rewardDebt;
            if (pending > 0) {
                user.pendingRewards = user.pendingRewards + pending;
            }
        }

        if (_amount > 0) {
            user.amount = user.amount + _amount;
            stakedToken.safeTransferFrom(msg.sender, address(this), _amount);

            // Track new participant
            if (!hasParticipated[msg.sender]) {
                hasParticipated[msg.sender] = true;
                participantCount++;
                emit NewParticipant(msg.sender);
            }
        }

        user.rewardDebt = user.amount * accTokenPerShare / PRECISION_FACTOR;

        emit Deposit(msg.sender, _amount);
    }

    // New function to get participation stats
    function getParticipationStats() external view returns (uint256 current, uint256 maximum) {
        return (participantCount, maxParticipants);
    }
}
