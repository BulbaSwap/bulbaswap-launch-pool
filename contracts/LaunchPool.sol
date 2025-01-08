// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/security/ReentrancyGuard.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

contract LaunchPool is Ownable, ReentrancyGuard {
    using SafeERC20 for IERC20;

    // The address of the smart chef factory
    address public LAUNCH_POOL_FACTORY;

    // Whether a limit is set for users
    bool public hasUserLimit;

    // Whether it is initialized
    bool public isInitialized;

    // Accrued token per share
    uint256 public accTokenPerShare;

    // The time when reward mining ends.
    uint256 public endTime;

    // The time when reward mining starts.
    uint256 public startTime;

    // The time of the last pool update
    uint256 public lastRewardTime;

    // The pool limit (0 if none)
    uint256 public poolLimitPerUser;

    // Tokens created per second.
    uint256 public rewardPerSecond;

    // The precision factor
    uint256 public PRECISION_FACTOR;

    // The reward token
    IERC20 public rewardToken;

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
    event RewardsStop(uint256 timestamp);
    event Withdraw(address indexed user, uint256 amount);
    event RewardClaimed(address indexed user, uint256 amount);

    constructor() {
        LAUNCH_POOL_FACTORY = msg.sender;
    }

    /*
     * @notice Initialize the contract
     * @param _stakedToken: staked token address
     * @param _rewardToken: reward token address
     * @param _rewardPerSecond: reward per second (in rewardToken)
     * @param _startTime: start time
     * @param _endTime: end time
     * @param _poolLimitPerUser: pool limit per user in stakedToken (if any, else 0)
     * @param _admin: admin address with ownership
     */
    function initialize(
        IERC20 _stakedToken,
        IERC20 _rewardToken,
        uint256 _rewardPerSecond,
        uint256 _startTime,
        uint256 _endTime,
        uint256 _poolLimitPerUser,
        address _admin
    ) external {
        require(!isInitialized, "Already initialized");
        require(msg.sender == LAUNCH_POOL_FACTORY, "Not factory");

        // Make this contract initialized
        isInitialized = true;

        stakedToken = _stakedToken;
        rewardToken = _rewardToken;
        rewardPerSecond = _rewardPerSecond;
        startTime = _startTime;
        endTime = _endTime;

        if (_poolLimitPerUser > 0) {
            hasUserLimit = true;
            poolLimitPerUser = _poolLimitPerUser;
        }

        uint256 decimalsRewardToken = IERC20Metadata(address(rewardToken)).decimals();
        require(decimalsRewardToken < 30, "Must be inferior to 30");

        PRECISION_FACTOR = 10**(uint256(30) - decimalsRewardToken);

        // Set the lastRewardTime as the startTime
        lastRewardTime = startTime;

        // Transfer ownership to the admin address who becomes owner of the contract
        transferOwnership(_admin);
    }

    /*
     * @notice Deposit staked tokens
     * @param _amount: amount to deposit (in stakedToken)
     */
    function deposit(uint256 _amount) external nonReentrant {
        UserInfo storage user = userInfo[msg.sender];

        require(block.timestamp >= startTime, "Pool has not started");
        require(block.timestamp < endTime, "Pool has ended");

        if (hasUserLimit) {
            require(_amount + user.amount <= poolLimitPerUser, "User amount above limit");
        }

        _updatePool();

        // Calculate pending rewards before deposit
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

    /*
     * @notice Withdraw staked tokens
     * @param _amount: amount to withdraw (in stakedToken)
     */
    function withdraw(uint256 _amount) external nonReentrant {
        UserInfo storage user = userInfo[msg.sender];
        require(user.amount >= _amount, "Amount to withdraw too high");

        _updatePool();

        // Calculate pending rewards before withdrawal
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

    /*
     * @notice Claim accumulated reward tokens
     * @dev Only callable after pool has ended
     */
    function claimReward() external nonReentrant {
        require(block.timestamp > endTime, "Pool has not ended");
        
        UserInfo storage user = userInfo[msg.sender];
        _updatePool();

        // Calculate current pending rewards
        uint256 pending = user.amount * accTokenPerShare / PRECISION_FACTOR - user.rewardDebt;
        
        // Add historical pending rewards
        uint256 totalPending = pending + user.pendingRewards;
        require(totalPending > 0, "No rewards to claim");

        // Reset pending rewards
        user.pendingRewards = 0;
        user.rewardDebt = user.amount * accTokenPerShare / PRECISION_FACTOR;

        // Transfer rewards
        rewardToken.safeTransfer(msg.sender, totalPending);

        emit RewardClaimed(msg.sender, totalPending);
    }

    /*
     * @notice Withdraw staked tokens without caring about rewards
     * @dev Needs to be for emergency.
     */
    function emergencyWithdraw() external nonReentrant {
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

    /*
     * @notice Stop rewards
     * @dev Only callable by owner. Needs to be for emergency.
     */
    function emergencyRewardWithdraw(uint256 _amount) external onlyOwner {
        rewardToken.safeTransfer(msg.sender, _amount);
    }

    /**
     * @notice It allows the admin to recover wrong tokens sent to the contract
     * @param _tokenAddress: the address of the token to withdraw
     * @param _tokenAmount: the number of tokens to withdraw
     * @dev This function is only callable by admin.
     */
    function recoverWrongTokens(address _tokenAddress, uint256 _tokenAmount) external onlyOwner {
        require(_tokenAddress != address(stakedToken), "Cannot be staked token");
        require(_tokenAddress != address(rewardToken), "Cannot be reward token");

        IERC20(_tokenAddress).safeTransfer(msg.sender, _tokenAmount);

        emit AdminTokenRecovery(_tokenAddress, _tokenAmount);
    }

    /*
     * @notice Stop rewards
     * @dev Only callable by owner
     */
    function stopReward() external onlyOwner {
        endTime = block.timestamp;
    }

    /*
     * @notice Update pool limit per user
     * @dev Only callable by owner.
     * @param _hasUserLimit: whether the limit remains forced
     * @param _poolLimitPerUser: new pool limit per user
     */
    function updatePoolLimitPerUser(bool _hasUserLimit, uint256 _poolLimitPerUser) external onlyOwner {
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

    /*
     * @notice Update reward per second
     * @dev Only callable by owner.
     * @param _rewardPerSecond: the reward per second
     */
    function updateRewardPerSecond(uint256 _rewardPerSecond) external onlyOwner {
        require(block.timestamp < startTime, "Pool has started");
        rewardPerSecond = _rewardPerSecond;
        emit NewRewardPerSecond(_rewardPerSecond);
    }

    /**
     * @notice It allows the admin to update start and end times
     * @dev This function is only callable by owner.
     * @param _startTime: the new start time
     * @param _endTime: the new end time
     */
    function updateStartAndEndTimes(uint256 _startTime, uint256 _endTime) external onlyOwner {
        require(block.timestamp < startTime, "Pool has started");
        require(_startTime < _endTime, "New startTime must be lower than new endTime");
        require(block.timestamp < _startTime, "New startTime must be higher than current timestamp");

        startTime = _startTime;
        endTime = _endTime;

        // Set the lastRewardTime as the startTime
        lastRewardTime = startTime;

        emit NewStartAndEndTimes(_startTime, _endTime);
    }

    /*
     * @notice View function to see pending reward on frontend.
     * @param _user: user address
     * @return Total pending rewards for the user
     */
    function pendingReward(address _user) external view returns (uint256) {
        UserInfo storage user = userInfo[_user];
        uint256 stakedTokenSupply = stakedToken.balanceOf(address(this));
        uint256 currentAccTokenPerShare = accTokenPerShare;
        
        if (block.timestamp > lastRewardTime && stakedTokenSupply != 0) {
            uint256 multiplier = _getMultiplier(lastRewardTime, block.timestamp);
            uint256 reward = multiplier * rewardPerSecond;
            currentAccTokenPerShare = currentAccTokenPerShare + 
                reward * PRECISION_FACTOR / stakedTokenSupply;
        }
        
        uint256 currentPending = user.amount * currentAccTokenPerShare / PRECISION_FACTOR - user.rewardDebt;
        return currentPending + user.pendingRewards;
    }

    /*
     * @notice Update reward variables of the given pool to be up-to-date.
     */
    function _updatePool() internal {
        if (block.timestamp <= lastRewardTime) {
            return;
        }

        uint256 stakedTokenSupply = stakedToken.balanceOf(address(this));

        if (stakedTokenSupply == 0) {
            lastRewardTime = block.timestamp;
            return;
        }

        uint256 multiplier = _getMultiplier(lastRewardTime, block.timestamp);
        uint256 reward = multiplier * rewardPerSecond;
        accTokenPerShare = accTokenPerShare + reward * PRECISION_FACTOR / stakedTokenSupply;
        lastRewardTime = block.timestamp;
    }

    /*
     * @notice Return reward multiplier over the given _from to _to time.
     * @param _from: time to start
     * @param _to: time to finish
     */
    function _getMultiplier(uint256 _from, uint256 _to) internal view returns (uint256) {
        if (_to <= endTime) {
            return _to - _from;
        } else if (_from >= endTime) {
            return 0;
        } else {
            return endTime - _from;
        }
    }
}
