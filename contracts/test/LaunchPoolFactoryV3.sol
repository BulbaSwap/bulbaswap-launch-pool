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
    function initialize() external override reinitializer(3) {
        minProjectInterval = 1 days;
    }

    // Override internal _createProject to add time interval check
    function _createProject(
        IERC20 _rewardToken,
        uint256 _totalRewardAmount,
        uint256 _startTime,
        uint256 _endTime,
        PoolMetadata calldata _metadata,
        InitialPoolParams calldata _initialPool,
        address _projectOwner
    ) internal virtual override returns (uint256 projectId) {
        // Check if user has created a project recently
        if (ownerProjectCount[_projectOwner] > 0) {
            require(
                _startTime >= block.timestamp + minProjectInterval,
                "Must wait before creating new project"
            );
        }
        
        return super._createProject(
            _rewardToken,
            _totalRewardAmount,
            _startTime,
            _endTime,
            _metadata,
            _initialPool,
            _projectOwner
        );
    }

    // New function to set minimum project interval
    function setMinProjectInterval(uint256 _interval) external onlyOwner {
        minProjectInterval = _interval;
    }
}
