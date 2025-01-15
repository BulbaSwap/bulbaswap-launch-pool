// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "../LaunchPoolFactoryUpgradeable.sol";
import "../LaunchPool.sol";
import "./Events.sol";

library ProjectLib {
    function createProject(
        mapping(uint256 => LaunchPoolFactoryUpgradeable.ProjectToken) storage projects,
        uint256 nextProjectId,
        IERC20 _rewardToken,
        uint256 _totalRewardAmount,
        uint256 _startTime,
        uint256 _endTime,
        LaunchPoolFactoryUpgradeable.PoolMetadata calldata _metadata,
        address _projectOwner
    ) internal returns (uint256 projectId) {
        require(_rewardToken.totalSupply() >= 0, "Invalid reward token");
        require(_startTime > block.timestamp, "Start time must be future");
        require(_endTime > _startTime, "End time must be after start time");
        require(_projectOwner != address(0), "Invalid project owner");
        
        projectId = nextProjectId;
        LaunchPoolFactoryUpgradeable.ProjectToken storage project = projects[projectId];
        
        project.rewardToken = _rewardToken;
        project.totalRewardAmount = _totalRewardAmount;
        project.startTime = _startTime;
        project.endTime = _endTime;
        project.metadata = _metadata;
        project.status = LaunchPoolFactoryUpgradeable.ProjectStatus.STAGING;
        project.owner = _projectOwner;
        
        emit Events.NewProject(projectId, address(_rewardToken), _projectOwner, _metadata);
        emit Events.ProjectStatusUpdated(projectId, LaunchPoolFactoryUpgradeable.ProjectStatus.STAGING);
        
        return projectId;
    }

    function updateProjectStatus(
        mapping(uint256 => LaunchPoolFactoryUpgradeable.ProjectToken) storage projects,
        uint256 _projectId,
        LaunchPoolFactoryUpgradeable.ProjectStatus _status
    ) internal {
        LaunchPoolFactoryUpgradeable.ProjectToken storage project = projects[_projectId];
        require(address(project.rewardToken) != address(0), "Project does not exist");
        
        if (_status == LaunchPoolFactoryUpgradeable.ProjectStatus.READY) {
            require(project.status == LaunchPoolFactoryUpgradeable.ProjectStatus.STAGING, "Can only move to READY from STAGING");
            require(project.fundedPoolCount == project.pools.length, "Not all pools funded");
            
            uint256 totalAllocated = 0;
            for (uint256 i = 0; i < project.pools.length; i++) {
                LaunchPool currentPool = LaunchPool(project.pools[i]);
                totalAllocated += currentPool.poolRewardAmount();
            }
            require(totalAllocated == project.totalRewardAmount, "Total allocated rewards must match total");
        } else if (_status == LaunchPoolFactoryUpgradeable.ProjectStatus.DELISTED) {
            require(project.status == LaunchPoolFactoryUpgradeable.ProjectStatus.STAGING || 
                   project.status == LaunchPoolFactoryUpgradeable.ProjectStatus.READY, "Can only delist from STAGING or READY");
        } else if (_status == LaunchPoolFactoryUpgradeable.ProjectStatus.PAUSED) {
            require(project.status == LaunchPoolFactoryUpgradeable.ProjectStatus.READY, "Can only pause from READY state");
        } else if (_status == LaunchPoolFactoryUpgradeable.ProjectStatus.STAGING) {
            require(project.status == LaunchPoolFactoryUpgradeable.ProjectStatus.PAUSED, "Can only move to STAGING from PAUSED");
        }
        
        project.status = _status;
        emit Events.ProjectStatusUpdated(_projectId, _status);
    }

    function updateProjectMetadata(
        mapping(uint256 => LaunchPoolFactoryUpgradeable.ProjectToken) storage projects,
        uint256 _projectId,
        LaunchPoolFactoryUpgradeable.PoolMetadata calldata _metadata
    ) internal {
        LaunchPoolFactoryUpgradeable.ProjectToken storage project = projects[_projectId];
        require(address(project.rewardToken) != address(0), "Project does not exist");
        project.metadata = _metadata;
        emit Events.PoolMetadataUpdated(_projectId, _metadata);
    }

    function transferProjectOwnership(
        mapping(uint256 => LaunchPoolFactoryUpgradeable.ProjectToken) storage projects,
        uint256 _projectId,
        address _newOwner
    ) internal {
        LaunchPoolFactoryUpgradeable.ProjectToken storage project = projects[_projectId];
        require(_newOwner != address(0), "New owner is zero address");
        
        address oldOwner = project.owner;
        project.owner = _newOwner;
        emit Events.ProjectOwnershipTransferred(_projectId, oldOwner, _newOwner);
    }
}
