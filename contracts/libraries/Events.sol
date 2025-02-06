// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import "../LaunchPoolFactoryUpgradeable.sol";

library Events {
    event NewProject(uint256 indexed projectId, address indexed rewardToken, address indexed owner, LaunchPoolFactoryUpgradeable.PoolMetadata metadata);
    event NewLaunchPool(uint256 indexed projectId, address indexed launchPool, uint256 version);
    event ProjectStatusUpdated(uint256 indexed projectId, LaunchPoolFactoryUpgradeable.ProjectStatus status);
    event PoolMetadataUpdated(uint256 indexed projectId, LaunchPoolFactoryUpgradeable.PoolMetadata metadata);
    event PoolFunded(uint256 indexed projectId, address indexed pool);
    event ProjectOwnershipTransferred(uint256 indexed projectId, address indexed previousOwner, address indexed newOwner);
    event FactoryUpgraded(address indexed implementation);
    event RemainingRewardsWithdrawn(address indexed owner, uint256 amount);
}
