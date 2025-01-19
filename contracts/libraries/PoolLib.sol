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
        mapping(uint256 => LaunchPoolFactoryUpgradeable.ProjectToken) storage projects,
        uint256 _projectId,
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
        mapping(uint256 => LaunchPoolFactoryUpgradeable.ProjectToken) storage projects,
        uint256 _projectId,
        uint256 _poolRewardAmount
    ) internal view returns (uint256) {
        LaunchPoolFactoryUpgradeable.ProjectToken storage project = projects[_projectId];
        uint256 duration = project.endTime - project.startTime;
        return (_poolRewardAmount + duration - 1) / duration; // Ceiling division
    }

    function getProjectPools(
        mapping(uint256 => LaunchPoolFactoryUpgradeable.ProjectToken) storage projects,
        uint256 _projectId
    ) internal view returns (LaunchPoolFactoryUpgradeable.PoolInfo[] memory) {
        LaunchPoolFactoryUpgradeable.ProjectToken storage project = projects[_projectId];
        address payable[] memory poolAddresses = new address payable[](project.pools.length);
        for (uint256 i = 0; i < project.pools.length; i++) {
            poolAddresses[i] = payable(project.pools[i]);
        }
        LaunchPoolFactoryUpgradeable.PoolInfo[] memory poolInfos = new LaunchPoolFactoryUpgradeable.PoolInfo[](poolAddresses.length);
        
        for (uint256 i = 0; i < poolAddresses.length; i++) {
            LaunchPool currentPool = LaunchPool(poolAddresses[i]);
            poolInfos[i] = LaunchPoolFactoryUpgradeable.PoolInfo({
                poolAddress: poolAddresses[i],
                stakedToken: address(currentPool.stakedToken()),
                rewardToken: address(project.rewardToken),
                rewardPerSecond: currentPool.rewardPerSecond(),
                startTime: project.startTime,
                endTime: project.endTime,
                poolLimitPerUser: currentPool.poolLimitPerUser(),
                minStakeAmount: currentPool.minStakeAmount()
            });
        }
        
        return poolInfos;
    }

    // LaunchPool specific functions
    // ETH address constant
    address constant internal ETH = 0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE;

    function updatePool(
        uint256 accTokenPerShare,
        uint256 lastRewardTime,
        uint256 rewardPerSecond,
        uint256 startTime,
        uint256 endTime,
        uint256 precisionFactor,
        IERC20 stakedToken,
        address payable caller
    ) internal view returns (uint256 newAccTokenPerShare, uint256 newLastRewardTime) {
        newAccTokenPerShare = accTokenPerShare;
        newLastRewardTime = lastRewardTime;

        // If current time is less than or equal to last reward time, no update needed
        if (block.timestamp <= lastRewardTime) {
            return (newAccTokenPerShare, newLastRewardTime);
        }

        // If current time is less than start time, update last reward time to start time
        if (block.timestamp < startTime) {
            newLastRewardTime = startTime;
            return (newAccTokenPerShare, newLastRewardTime);
        }

        // If last reward time is greater than or equal to end time, no update needed
        if (lastRewardTime >= endTime) {
            return (newAccTokenPerShare, newLastRewardTime);
        }

        // Get staked token supply based on token type
        uint256 stakedTokenSupply;
        if (address(stakedToken) == ETH) {
            stakedTokenSupply = LaunchPool(caller).totalStaked();
        } else {
            stakedTokenSupply = stakedToken.balanceOf(caller);
        }

        // If no staked tokens, only update last reward time
        if (stakedTokenSupply == 0) {
            newLastRewardTime = block.timestamp > endTime ? endTime : block.timestamp;
            return (newAccTokenPerShare, newLastRewardTime);
        }

        // Calculate end point (not exceeding end time)
        uint256 endPoint = block.timestamp > endTime ? endTime : block.timestamp;
        
        // If last reward time is greater than or equal to end point, no update needed
        if (lastRewardTime >= endPoint) {
            return (newAccTokenPerShare, newLastRewardTime);
        }
        
        // Calculate and update rewards
        uint256 multiplier = getMultiplier(lastRewardTime, endPoint, startTime, endTime);
        uint256 reward = multiplier * rewardPerSecond;
        if (stakedTokenSupply > 0) {
            newAccTokenPerShare = newAccTokenPerShare + reward * precisionFactor / stakedTokenSupply;
        }
        newLastRewardTime = endPoint;

        return (newAccTokenPerShare, newLastRewardTime);
    }

    function getMultiplier(
        uint256 _from,
        uint256 _to,
        uint256 startTime,
        uint256 endTime
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
        uint256 actualFrom = _from < startTime ? startTime : _from;
        uint256 actualTo = _to > endTime ? endTime : _to;
        
        // If adjusted start time is after adjusted end time, no rewards
        if (actualFrom >= actualTo) {
            return 0;
        }
        
        return actualTo - actualFrom;
    }
}
