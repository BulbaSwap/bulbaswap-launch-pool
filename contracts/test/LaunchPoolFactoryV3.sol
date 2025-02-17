// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import "./LaunchPoolFactoryV2.sol";

contract LaunchPoolFactoryV3 is LaunchPoolFactoryV2 {
    // Add new feature for testing upgrade
    uint256 public minProjectInterval;

    // Override internal initialization
    function _init() internal virtual override {
        super._init();
        minProjectInterval = 1 days; // Default interval
    }

    // Initialize V3
    function initializeV3() external reinitializer(3) {
        minProjectInterval = 1 days;
    }

    // Override internal _createProject to add time interval check
    function _createProject(
        IERC20 _rewardToken,
        uint256 _totalRewardAmount,
        uint32 _startTime,
        uint32 _endTime,
        PoolMetadata calldata _metadata,
        InitialPoolParams[] calldata _initialPools,
        address _projectOwner
    ) internal virtual override returns (uint256) {
        // Check if user has created a project recently
        if (ownerProjectCount[_projectOwner] > 0) {
            require(
                _startTime >= uint32(block.timestamp) + uint32(minProjectInterval),
                "Must wait before creating new project"
            );
        }
        
        return super._createProject(
            _rewardToken,
            _totalRewardAmount,
            _startTime,
            _endTime,
            _metadata,
            _initialPools,
            _projectOwner
        );
    }

    // New function to set minimum project interval
    function setMinProjectInterval(uint256 _interval) external onlyOwner {
        minProjectInterval = _interval;
    }

    /// @dev Prevents renouncing ownership since it would break the factory
    function renounceOwnership() public virtual override onlyOwner {
        revert("Cannot renounce ownership");
    }
}
