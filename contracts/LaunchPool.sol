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

    // The ID of the project this pool belongs to
    uint32 public projectId;

    // Whether a limit is set for users
    bool public hasUserLimit;

    // Whether it is initialized
    bool public isInitialized;

    // The factory contract
    LaunchPoolFactoryUpgradeable public factory;

    // Accrued token per share
    uint256 public accTokenPerShare;

    // The time of the last pool update
    uint32 public lastRewardTime;

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

    // Total staked amount for all pools (ETH and ERC20)
    uint256 public totalStaked;

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
    event NewStartAndEndTimes(uint32 startTime, uint32 endTime);
    event NewPoolLimit(uint256 poolLimitPerUser);
    event NewMinStakeAmount(uint256 minStakeAmount);
    event Withdraw(address indexed user, uint256 amount);
    event RewardClaimed(address indexed user, uint256 amount);

    modifier onlyProjectOwner() {
        require(factory.isProjectOwner(projectId, msg.sender), "Not project owner");
        _;
    }

    constructor() {}

    function initialize(
        IERC20 _stakedToken,
        uint256 _poolRewardAmount,
        uint256 _poolLimitPerUser,
        uint256 _minStakeAmount,
        uint32 _projectId
    ) external virtual {
        require(!isInitialized, "Already initialized");
        
        factory = LaunchPoolFactoryUpgradeable(msg.sender);
        isInitialized = true;
        projectId = uint32(_projectId);
        stakedToken = _stakedToken;
        poolRewardAmount = _poolRewardAmount;
        minStakeAmount = _minStakeAmount;

        if (_poolLimitPerUser > 0) {
            hasUserLimit = true;
            poolLimitPerUser = _poolLimitPerUser;
        }

        rewardPerSecond = factory.calculateRewardPerSecond(projectId, _poolRewardAmount);

        uint256 decimalsRewardToken = IERC20Metadata(address(rewardToken())).decimals();
        require(decimalsRewardToken < 36, "Must be inferior to 36");
        PRECISION_FACTOR = 10**(uint256(36) - decimalsRewardToken);

        (uint32 startTime,) = getProjectTimes();
        lastRewardTime = startTime;
    }

    function owner() external view returns (address) {
        return factory.getProjectOwner(projectId);
    }

    function rewardToken() public view returns (IERC20) {
        return factory.getProjectRewardToken(projectId);
    }

    function getProjectTimes() public view returns (uint32 startTime, uint32 endTime) {
        return factory.getProjectTimes(projectId);
    }

    address constant internal ETH = 0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE;

    function deposit(uint256 _amount) external virtual payable nonReentrant {
        UserInfo storage user = userInfo[msg.sender];
        uint256 currentAmount = user.amount;
        uint256 currentAccTokenPerShare = accTokenPerShare;

        bytes32 statusHash = keccak256(bytes(factory.getProjectStatus(projectId)));
        require(statusHash == ACTIVE || statusHash == READY, "Pool must be active or ready");

        if (_amount > 0) {
            require(_amount >= minStakeAmount, "Amount below minimum stake");
            if (hasUserLimit) {
                require(_amount + currentAmount <= poolLimitPerUser, "User amount above limit");
            }
        }

        _updatePool();
        currentAccTokenPerShare = accTokenPerShare;

        if (currentAmount > 0) {
            uint256 pending = currentAmount * currentAccTokenPerShare / PRECISION_FACTOR - user.rewardDebt;
            if (pending > 0) {
                user.pendingRewards = user.pendingRewards + pending;
            }
        }

        if (_amount > 0) {
            currentAmount = currentAmount + _amount;
            totalStaked += _amount;
            if (address(stakedToken) == ETH) {
                require(msg.value == _amount, "Invalid ETH amount");
            } else {
                stakedToken.safeTransferFrom(msg.sender, address(this), _amount);
            }
        }

        user.amount = currentAmount;
        user.rewardDebt = currentAmount * currentAccTokenPerShare / PRECISION_FACTOR;

        emit Deposit(msg.sender, _amount);
    }

    function withdraw(uint256 _amount) external nonReentrant {
        UserInfo storage user = userInfo[msg.sender];
        uint256 currentAmount = user.amount;
        uint256 currentAccTokenPerShare = accTokenPerShare;

        bytes32 statusHash = keccak256(bytes(factory.getProjectStatus(projectId)));
        require(
            statusHash == ACTIVE || 
            statusHash == ENDED || 
            statusHash == PAUSED || 
            statusHash == DELISTED ||
            statusHash == READY,
            "Pool must be active, ended, paused, delisted or ready"
        );
        require(currentAmount >= _amount, "Amount to withdraw too high");

        _updatePool();
        currentAccTokenPerShare = accTokenPerShare;

        uint256 pending = currentAmount * currentAccTokenPerShare / PRECISION_FACTOR - user.rewardDebt;
        if (pending > 0) {
            user.pendingRewards = user.pendingRewards + pending;
        }

        if (_amount > 0) {
            currentAmount = currentAmount - _amount;
            totalStaked -= _amount;
            if (address(stakedToken) == ETH) {
                (bool success, ) = msg.sender.call{value: _amount}("");
                require(success, "ETH transfer failed");
            } else {
                stakedToken.safeTransfer(msg.sender, _amount);
            }
        }

        user.amount = currentAmount;
        user.rewardDebt = currentAmount * currentAccTokenPerShare / PRECISION_FACTOR;

        emit Withdraw(msg.sender, _amount);
    }

    function claimReward() external nonReentrant {
        bytes32 statusHash = keccak256(bytes(factory.getProjectStatus(projectId)));
        require(statusHash == ENDED, "Pool not ended");
        
        UserInfo storage user = userInfo[msg.sender];
        uint256 currentAmount = user.amount;
        uint256 currentAccTokenPerShare = accTokenPerShare;

        _updatePool();
        currentAccTokenPerShare = accTokenPerShare;

        uint256 pending = currentAmount * currentAccTokenPerShare / PRECISION_FACTOR - user.rewardDebt;
        uint256 totalPending = pending + user.pendingRewards;
        require(totalPending > 0, "No rewards to claim");

        user.pendingRewards = 0;
        user.rewardDebt = currentAmount * currentAccTokenPerShare / PRECISION_FACTOR;

        rewardToken().safeTransfer(msg.sender, totalPending);

        emit RewardClaimed(msg.sender, totalPending);
    }

    function emergencyWithdraw() external nonReentrant {
        bytes32 statusHash = keccak256(bytes(factory.getProjectStatus(projectId)));
        require(statusHash == PAUSED || statusHash == DELISTED, "Pool must be paused or delisted");
        UserInfo storage user = userInfo[msg.sender];
        uint256 amountToTransfer = user.amount;
        user.amount = 0;
        user.rewardDebt = 0;
        user.pendingRewards = 0;

        if (amountToTransfer > 0) {
            totalStaked -= amountToTransfer;
            if (address(stakedToken) == ETH) {
                (bool success, ) = msg.sender.call{value: amountToTransfer}("");
                require(success, "ETH transfer failed");
            } else {
                stakedToken.safeTransfer(msg.sender, amountToTransfer);
            }
        }

        emit EmergencyWithdraw(msg.sender, amountToTransfer);
    }

    receive() external payable {
        revert("Use deposit() to stake ETH");
    }

    fallback() external payable {
        revert("Use deposit() to stake ETH");
    }

    function emergencyRewardWithdraw(uint256 _amount) external onlyProjectOwner {
        bytes32 statusHash = keccak256(bytes(factory.getProjectStatus(projectId)));
        require(statusHash == PAUSED || statusHash == DELISTED, "Pool must be paused or delisted");
        rewardToken().safeTransfer(msg.sender, _amount);
    }

    function recoverWrongTokens(address _tokenAddress, uint256 _tokenAmount) external onlyProjectOwner {
        require(_tokenAddress != address(stakedToken), "Cannot be staked token");
        require(_tokenAddress != address(rewardToken()), "Cannot be reward token");
        require(_tokenAmount > 0, "Amount must be positive");
        require(_tokenAmount <= IERC20(_tokenAddress).balanceOf(address(this)), "Insufficient balance");

        IERC20(_tokenAddress).safeTransfer(msg.sender, _tokenAmount);
        emit AdminTokenRecovery(_tokenAddress, _tokenAmount);
    }

    function updatePoolLimitPerUser(bool _hasUserLimit, uint256 _poolLimitPerUser) external onlyProjectOwner {
        if (_hasUserLimit) {
            require(_poolLimitPerUser > 0, "Pool limit must be positive");
            poolLimitPerUser = _poolLimitPerUser;
            hasUserLimit = true;
        } else {
            hasUserLimit = false;
            poolLimitPerUser = 0;
        }
        emit NewPoolLimit(poolLimitPerUser);
    }

    function updateMinStakeAmount(uint256 _minStakeAmount) external onlyProjectOwner {
        minStakeAmount = _minStakeAmount;
        emit NewMinStakeAmount(_minStakeAmount);
    }

    function getTotalDistributedRewards() public view returns (uint256) {
        (uint32 startTime, uint32 endTime) = getProjectTimes();
        uint256 duration = endTime - startTime;
        return duration * rewardPerSecond;
    }

    function withdrawRemainingRewards() external onlyProjectOwner {
        bytes32 statusHash = keccak256(bytes(factory.getProjectStatus(projectId)));
        require(statusHash == ENDED, "Pool must be ended");
        
        uint256 distributedRewards = getTotalDistributedRewards();
        uint256 balance = rewardToken().balanceOf(address(this));
        require(balance > distributedRewards, "No rewards to withdraw");
        
        uint256 remainingRewards = balance - distributedRewards;
        rewardToken().safeTransfer(msg.sender, remainingRewards);
        emit Events.RemainingRewardsWithdrawn(msg.sender, remainingRewards);
    }

    function pendingReward(address _user) external view returns (uint256) {
        UserInfo storage user = userInfo[_user];
        uint256 stakedTokenSupply = totalStaked;
        (uint32 startTime, uint32 endTime) = getProjectTimes();
        
        return PoolLib.calculatePendingRewards(
            accTokenPerShare,
            rewardPerSecond,
            PRECISION_FACTOR,
            stakedTokenSupply,
            lastRewardTime,
            startTime,
            endTime,
            user.amount,
            user.rewardDebt,
            user.pendingRewards
        );
    }

    function _updatePool() internal {
        (uint32 startTime, uint32 endTime) = getProjectTimes();
        
        (uint256 newAccTokenPerShare, uint32 newLastRewardTime) = PoolLib.updatePool(
            accTokenPerShare,
            lastRewardTime,
            rewardPerSecond,
            startTime,
            endTime,
            PRECISION_FACTOR,
            stakedToken,
            payable(address(this))
        );

        accTokenPerShare = newAccTokenPerShare;
        lastRewardTime = newLastRewardTime;
    }
}
