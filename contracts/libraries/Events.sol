// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import "../LaunchPoolFactoryUpgradeable.sol";

library Events {
    event NewProject(uint32 indexed projectId, address indexed rewardToken, address indexed owner, LaunchPoolFactoryUpgradeable.PoolMetadata metadata);
    event NewLaunchPool(uint32 indexed projectId, address indexed launchPool, uint256 version);
    event ProjectStatusUpdated(uint32 indexed projectId, LaunchPoolFactoryUpgradeable.ProjectStatus status);
    event PoolMetadataUpdated(uint32 indexed projectId, LaunchPoolFactoryUpgradeable.PoolMetadata metadata);
    event PoolFunded(uint32 indexed projectId, address indexed pool);
    event ProjectOwnershipTransferred(uint32 indexed projectId, address indexed previousOwner, address indexed newOwner);
    event ProjectOwnershipTransferStarted(uint32 indexed projectId, address indexed previousOwner, address indexed pendingOwner);
    event ProjectOwnershipTransferCanceled(uint32 indexed projectId, address indexed currentOwner, address indexed pendingOwner);
    event FactoryUpgraded(address indexed implementation);
    event RemainingRewardsWithdrawn(address indexed owner, uint256 amount);
}
