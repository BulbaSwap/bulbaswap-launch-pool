// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import "@openzeppelin/contracts/security/ReentrancyGuard.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "./LaunchPoolFactoryUpgradeable.sol";
import "./libraries/PoolLib.sol";

contract LaunchPool is ReentrancyGuard {
    using SafeERC20 for IERC20;

    // Status constants
    bytes32 internal constant ACTIVE = keccak256(bytes("ACTIVE"));
    bytes32 internal constant PAUSED = keccak256(bytes("PAUSED"));
    bytes32 internal constant ENDED = keccak256(bytes("ENDED"));
    bytes32 internal constant DELISTED = keccak256(bytes("DELISTED"));
    bytes32 internal constant READY = keccak256(bytes("READY"));

    // The address of the launch pool factory
    address public immutable LAUNCH_POOL_FACTORY;

    // The ID of the project this pool belongs to
    uint256 public projectId;

    // Whether a limit is set for users
    bool public hasUserLimit;

    // Whether it is initialized
    bool public isInitialized;

    // The factory contract
    LaunchPoolFactoryUpgradeable public immutable factory;

    // Accrued token per share
    uint256 public accTokenPerShare;

    // The time of the last pool update
    uint256 public lastRewardTime;

    // The pool limit (0 if none)
    uint256 public poolLimitPerUser;

    // The minimum stake amount
    uint256 public minStakeAmount;

    // Total reward amount for this pool
    uint256 public poolRewardAmount;

    // Tokens created per second
    uint256 public rewardPerSecond;

    // The precision factor
    uint256 public PRECISION_FACTOR;

    // The staked token
    IERC20 public stakedToken;

    // Info of each user that stakes tokens (stakedToken)
    mapping(address => UserInfo) public userInfo;

    struct UserInfo {
        uint256 amount; // How many staked tokens the user has provided
        uint256 rewardDebt; // Reward debt
        uint256 pendingRewards; // Accumulated rewards pending claim
    }

    event AdminTokenRecovery(address tokenRecovered, uint256 amount);
    event Deposit(address indexed user, uint256 amount);
    event EmergencyWithdraw(address indexed user, uint256 amount);
    event NewStartAndEndTimes(uint256 startTime, uint256 endTime);
    event NewRewardPerSecond(uint256 rewardPerSecond);
    event NewPoolLimit(uint256 poolLimitPerUser);
    event NewMinStakeAmount(uint256 minStakeAmount);
    event RewardsStop(uint256 timestamp);
    event Withdraw(address indexed user, uint256 amount);
    event RewardClaimed(address indexed user, uint256 amount);

    modifier onlyProjectOwner() {
        require(factory.isProjectOwner(projectId, msg.sender), "Not project owner");
        _;
    }

    constructor() {
        LAUNCH_POOL_FACTORY = msg.sender;
        factory = LaunchPoolFactoryUpgradeable(msg.sender);
    }

    function initialize(
        IERC20 _stakedToken,
        uint256 _poolRewardAmount,
        uint256 _poolLimitPerUser,
        uint256 _minStakeAmount,
        uint256 _projectId
    ) external virtual {
        require(!isInitialized, "Already initialized");
        require(msg.sender == LAUNCH_POOL_FACTORY, "Not factory");

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
    }

    function owner() external view returns (address) {
        return factory.getProjectOwner(projectId);
    }

    function rewardToken() public view returns (IERC20) {
        return factory.getProjectRewardToken(projectId);
    }

    function getProjectTimes() public view returns (uint256 startTime, uint256 endTime) {
        return factory.getProjectTimes(projectId);
    }

    function deposit(uint256 _amount) external virtual nonReentrant {
        UserInfo storage user = userInfo[msg.sender];

        bytes32 statusHash = keccak256(bytes(factory.getProjectStatus(projectId)));
        require(statusHash == ACTIVE, "Pool not active");

        // Only check minimum stake amount when deposit amount is greater than 0
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
        }

        user.rewardDebt = user.amount * accTokenPerShare / PRECISION_FACTOR;

        emit Deposit(msg.sender, _amount);
    }

    function withdraw(uint256 _amount) external nonReentrant {
        UserInfo storage user = userInfo[msg.sender];
        bytes32 statusHash = keccak256(bytes(factory.getProjectStatus(projectId)));
        require(statusHash != PAUSED && statusHash != DELISTED, "Pool not available");
        require(user.amount >= _amount, "Amount to withdraw too high");

        _updatePool();

        uint256 pending = user.amount * accTokenPerShare / PRECISION_FACTOR - user.rewardDebt;
        if (pending > 0) {
            user.pendingRewards = user.pendingRewards + pending;
        }

        if (_amount > 0) {
            user.amount = user.amount - _amount;
            stakedToken.safeTransfer(msg.sender, _amount);
        }

        user.rewardDebt = user.amount * accTokenPerShare / PRECISION_FACTOR;

        emit Withdraw(msg.sender, _amount);
    }

    function claimReward() external nonReentrant {
        bytes32 statusHash = keccak256(bytes(factory.getProjectStatus(projectId)));
        require(statusHash == ENDED, "Pool not ended");
        
        UserInfo storage user = userInfo[msg.sender];
        _updatePool();

        uint256 pending = user.amount * accTokenPerShare / PRECISION_FACTOR - user.rewardDebt;
        uint256 totalPending = pending + user.pendingRewards;
        require(totalPending > 0, "No rewards to claim");

        user.pendingRewards = 0;
        user.rewardDebt = user.amount * accTokenPerShare / PRECISION_FACTOR;

        rewardToken().safeTransfer(msg.sender, totalPending);

        emit RewardClaimed(msg.sender, totalPending);
    }

    function emergencyWithdraw() external nonReentrant {
        bytes32 statusHash = keccak256(bytes(factory.getProjectStatus(projectId)));
        require(statusHash != PAUSED && statusHash != DELISTED, "Pool not available");
        UserInfo storage user = userInfo[msg.sender];
        uint256 amountToTransfer = user.amount;
        user.amount = 0;
        user.rewardDebt = 0;
        user.pendingRewards = 0;

        if (amountToTransfer > 0) {
            stakedToken.safeTransfer(msg.sender, amountToTransfer);
        }

        emit EmergencyWithdraw(msg.sender, amountToTransfer);
    }

    function emergencyRewardWithdraw(uint256 _amount) external onlyProjectOwner {
        bytes32 statusHash = keccak256(bytes(factory.getProjectStatus(projectId)));
        require(statusHash == PAUSED || statusHash == DELISTED, "Pool must be paused or delisted");
        rewardToken().safeTransfer(msg.sender, _amount);
    }

    function recoverWrongTokens(address _tokenAddress, uint256 _tokenAmount) external onlyProjectOwner {
        bytes32 statusHash = keccak256(bytes(factory.getProjectStatus(projectId)));
        require(statusHash == PAUSED || statusHash == DELISTED, "Pool must be paused or delisted");
        require(_tokenAddress != address(stakedToken), "Cannot be staked token");
        require(_tokenAddress != address(rewardToken()), "Cannot be reward token");

        IERC20(_tokenAddress).safeTransfer(msg.sender, _tokenAmount);

        emit AdminTokenRecovery(_tokenAddress, _tokenAmount);
    }

    function stopReward() external onlyProjectOwner {
        bytes32 statusHash = keccak256(bytes(factory.getProjectStatus(projectId)));
        require(statusHash == ACTIVE || statusHash == READY, "Pool not in active or ready state");
        (,uint256 endTime) = getProjectTimes();
        endTime = block.timestamp;
        emit RewardsStop(block.timestamp);
    }

    function updatePoolLimitPerUser(bool _hasUserLimit, uint256 _poolLimitPerUser) external onlyProjectOwner {
        bytes32 statusHash = keccak256(bytes(factory.getProjectStatus(projectId)));
        require(statusHash == READY, "Pool not in ready state");
        require(hasUserLimit, "Must be set");
        if (_hasUserLimit) {
            require(_poolLimitPerUser > poolLimitPerUser, "New limit must be higher");
            poolLimitPerUser = _poolLimitPerUser;
        } else {
            hasUserLimit = _hasUserLimit;
            poolLimitPerUser = 0;
        }
        emit NewPoolLimit(poolLimitPerUser);
    }

    function updateMinStakeAmount(uint256 _minStakeAmount) external onlyProjectOwner {
        bytes32 statusHash = keccak256(bytes(factory.getProjectStatus(projectId)));
        require(statusHash == READY, "Pool not in ready state");
        minStakeAmount = _minStakeAmount;
        emit NewMinStakeAmount(_minStakeAmount);
    }

    function updateRewardPerSecond(uint256 _rewardPerSecond) external onlyProjectOwner {
        bytes32 statusHash = keccak256(bytes(factory.getProjectStatus(projectId)));
        require(statusHash == READY, "Pool not in ready state");
        rewardPerSecond = _rewardPerSecond;
        emit NewRewardPerSecond(_rewardPerSecond);
    }

    function pendingReward(address _user) external view returns (uint256) {
        UserInfo storage user = userInfo[_user];
        uint256 stakedTokenSupply = stakedToken.balanceOf(address(this));
        uint256 currentAccTokenPerShare = accTokenPerShare;
        (uint256 startTime, uint256 endTime) = getProjectTimes();
        
        // If current time is less than or equal to last reward time, return current rewards
        if (block.timestamp <= lastRewardTime) {
            return user.amount * currentAccTokenPerShare / PRECISION_FACTOR - user.rewardDebt + user.pendingRewards;
        }

        // If current time is less than start time, return current rewards
        if (block.timestamp < startTime) {
            return user.amount * currentAccTokenPerShare / PRECISION_FACTOR - user.rewardDebt + user.pendingRewards;
        }

        // If last reward time is greater than or equal to end time, return current rewards
        if (lastRewardTime >= endTime) {
            return user.amount * currentAccTokenPerShare / PRECISION_FACTOR - user.rewardDebt + user.pendingRewards;
        }

        // If no staked tokens, return current rewards
        if (stakedTokenSupply == 0) {
            return user.amount * currentAccTokenPerShare / PRECISION_FACTOR - user.rewardDebt + user.pendingRewards;
        }

        // Calculate end point (not exceeding end time)
        uint256 endPoint = block.timestamp > endTime ? endTime : block.timestamp;
        
        // If last reward time is greater than or equal to end point, return current rewards
        if (lastRewardTime >= endPoint) {
            return user.amount * currentAccTokenPerShare / PRECISION_FACTOR - user.rewardDebt + user.pendingRewards;
        }

        // Calculate new rewards
        uint256 multiplier = PoolLib.getMultiplier(lastRewardTime, endPoint, startTime, endTime);
        uint256 reward = multiplier * rewardPerSecond;
        currentAccTokenPerShare = currentAccTokenPerShare + reward * PRECISION_FACTOR / stakedTokenSupply;
        
        return user.amount * currentAccTokenPerShare / PRECISION_FACTOR - user.rewardDebt + user.pendingRewards;
    }

    function _updatePool() internal {
        (uint256 startTime, uint256 endTime) = getProjectTimes();
        
        (uint256 newAccTokenPerShare, uint256 newLastRewardTime) = PoolLib.updatePool(
            accTokenPerShare,
            lastRewardTime,
            rewardPerSecond,
            startTime,
            endTime,
            PRECISION_FACTOR,
            stakedToken
        );

        accTokenPerShare = newAccTokenPerShare;
        lastRewardTime = newLastRewardTime;
    }
}
