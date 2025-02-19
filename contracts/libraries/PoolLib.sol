// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/proxy/Clones.sol";
import "../LaunchPool.sol";
import "../LaunchPoolFactoryUpgradeable.sol";
import "./Events.sol";

library PoolLib {
    using SafeERC20 for IERC20;


    function fundPool(
        mapping(uint32 => LaunchPoolFactoryUpgradeable.ProjectToken) storage projects,
        uint32 _projectId,
        address payable _poolAddress,
        uint256 _amount
    ) internal {
        LaunchPoolFactoryUpgradeable.ProjectToken storage project = projects[_projectId];
        require(address(project.rewardToken) != address(0), "Project does not exist");
        require(project.status == LaunchPoolFactoryUpgradeable.ProjectStatus.STAGING, "Project not in staging");
        require(!project.poolFunded[_poolAddress], "Pool already funded");
        
        LaunchPool launchPool = LaunchPool(_poolAddress);
        require(launchPool.projectId() == _projectId, "Pool not in project");
        require(launchPool.poolRewardAmount() == _amount, "Amount must match pool reward amount");
        
        project.rewardToken.safeTransferFrom(msg.sender, _poolAddress, _amount);
        
        project.poolFunded[_poolAddress] = true;
        project.fundedPoolCount++;
        
        emit Events.PoolFunded(_projectId, _poolAddress);
        
        if (project.fundedPoolCount == project.pools.length) {
            uint256 totalAllocated = 0;
            for (uint256 i = 0; i < project.pools.length; i++) {
                LaunchPool currentPool = LaunchPool(payable(project.pools[i]));
                totalAllocated += currentPool.poolRewardAmount();
            }
            require(totalAllocated == project.totalRewardAmount, "Total allocated rewards must match total");
            
            project.status = LaunchPoolFactoryUpgradeable.ProjectStatus.READY;
            emit Events.ProjectStatusUpdated(_projectId, LaunchPoolFactoryUpgradeable.ProjectStatus.READY);
        }
    }

    function calculateRewardPerSecond(
        mapping(uint32 => LaunchPoolFactoryUpgradeable.ProjectToken) storage projects,
        uint32 _projectId,
        uint256 _poolRewardAmount
    ) internal view returns (uint256) {
        LaunchPoolFactoryUpgradeable.ProjectToken storage project = projects[_projectId];
        uint256 duration = project.endTime - project.startTime;
        return _poolRewardAmount / duration;
    }

    function getProjectPools(
        mapping(uint32 => LaunchPoolFactoryUpgradeable.ProjectToken) storage projects,
        uint32 _projectId
    ) internal view returns (LaunchPoolFactoryUpgradeable.PoolInfo[] memory) {
        LaunchPoolFactoryUpgradeable.ProjectToken storage project = projects[_projectId];
        uint256 poolsLength = project.pools.length;
        
        LaunchPoolFactoryUpgradeable.PoolInfo[] memory poolInfos = new LaunchPoolFactoryUpgradeable.PoolInfo[](poolsLength);
        
        for (uint256 i = 0; i < poolsLength; i++) {
            LaunchPool currentPool = LaunchPool(payable(project.pools[i]));
            poolInfos[i] = LaunchPoolFactoryUpgradeable.PoolInfo({
                poolAddress: payable(project.pools[i]),
                stakedToken: address(currentPool.stakedToken()),
                rewardToken: address(project.rewardToken),
                rewardPerSecond: currentPool.rewardPerSecond(),
                startTime: uint32(project.startTime),
                endTime: uint32(project.endTime),
                poolLimitPerUser: currentPool.poolLimitPerUser(),
                minStakeAmount: currentPool.minStakeAmount()
            });
        }
        
        return poolInfos;
    }

    // LaunchPool specific functions
    // ETH address constant
    address constant internal ETH = 0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE;

    struct RewardCalculationResult {
        uint256 newAccTokenPerShare;
        uint32 newLastRewardTime;
        uint256 pendingReward;
    }

    function calculateRewards(
        uint256 accTokenPerShare,
        uint32 lastRewardTime,
        uint256 rewardPerSecond,
        uint32 startTime,
        uint32 endTime,
        uint256 precisionFactor,
        uint256 stakedTokenSupply,
        uint256 userAmount,
        uint256 userRewardDebt,
        uint256 userPendingRewards
    ) internal view returns (RewardCalculationResult memory result) {
        result.newAccTokenPerShare = accTokenPerShare;
        result.newLastRewardTime = lastRewardTime;
        result.pendingReward = userAmount * accTokenPerShare / precisionFactor - userRewardDebt + userPendingRewards;

        // If current time is less than or equal to last reward time, no update needed
        if (block.timestamp <= lastRewardTime) {
            return result;
        }

        // If current time is less than start time, update last reward time to start time
        if (block.timestamp < startTime) {
            result.newLastRewardTime = startTime;
            return result;
        }

        // If last reward time is greater than or equal to end time, no update needed
        if (lastRewardTime >= endTime) {
            return result;
        }

        // If no staked tokens, only update last reward time
        if (stakedTokenSupply == 0) {
            result.newLastRewardTime = uint32(block.timestamp > endTime ? endTime : block.timestamp);
            return result;
        }

        // Calculate end point (not exceeding end time)
        uint32 endPoint = uint32(block.timestamp > endTime ? endTime : block.timestamp);
        
        // If last reward time is greater than or equal to end point, no update needed
        if (lastRewardTime >= endPoint) {
            return result;
        }
        
        // Calculate and update rewards
        uint256 multiplier = getMultiplier(lastRewardTime, endPoint, startTime, endTime);
        uint256 reward = multiplier * rewardPerSecond;
        if (stakedTokenSupply > 0) {
            uint256 addition = reward * precisionFactor / stakedTokenSupply;
            result.newAccTokenPerShare = accTokenPerShare + addition;
            result.pendingReward = userAmount * result.newAccTokenPerShare / precisionFactor - userRewardDebt + userPendingRewards;
        }
        result.newLastRewardTime = uint32(endPoint);

        return result;
    }

    function updatePool(
        uint256 accTokenPerShare,
        uint32 lastRewardTime,
        uint256 rewardPerSecond,
        uint32 startTime,
        uint32 endTime,
        uint256 precisionFactor,
        IERC20 /* stakedToken */,
        address payable caller
    ) internal view returns (uint256 newAccTokenPerShare, uint32 newLastRewardTime) {
        uint256 stakedTokenSupply = LaunchPool(caller).totalStaked();
        
        RewardCalculationResult memory result = calculateRewards(
            accTokenPerShare,
            lastRewardTime,
            rewardPerSecond,
            startTime,
            endTime,
            precisionFactor,
            stakedTokenSupply,
            0, // userAmount not needed for pool update
            0, // userRewardDebt not needed for pool update
            0  // userPendingRewards not needed for pool update
        );
        
        return (result.newAccTokenPerShare, result.newLastRewardTime);
    }

    function calculatePendingRewards(
        uint256 currentAccTokenPerShare,
        uint256 rewardPerSecond,
        uint256 precisionFactor,
        uint256 stakedTokenSupply,
        uint32 lastRewardTime,
        uint32 startTime,
        uint32 endTime,
        uint256 userAmount,
        uint256 userRewardDebt,
        uint256 userPendingRewards
    ) internal view returns (uint256) {
        RewardCalculationResult memory result = calculateRewards(
            currentAccTokenPerShare,
            lastRewardTime,
            rewardPerSecond,
            startTime,
            endTime,
            precisionFactor,
            stakedTokenSupply,
            userAmount,
            userRewardDebt,
            userPendingRewards
        );
        
        return result.pendingReward;
    }

    function getMultiplier(
        uint32 _from,
        uint32 _to,
        uint32 startTime,
        uint32 endTime
    ) internal pure returns (uint256) {
        // If start time is after end time, no rewards
        if (_from >= endTime) {
            return 0;
        }
        
        // If end time is before start time, no rewards
        if (_to <= startTime) {
            return 0;
        }
        
        // Adjust actual start and end times
        uint32 actualFrom = _from < startTime ? startTime : _from;
        uint32 actualTo = _to > endTime ? endTime : _to;
        
        // If adjusted start time is after adjusted end time, no rewards
        if (actualFrom >= actualTo) {
            return 0;
        }
        
        return actualTo - actualFrom;
    }
}
