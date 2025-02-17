// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import "../LaunchPoolFactoryUpgradeable.sol";
import "./LaunchPoolV2.sol";
import "../libraries/Events.sol";
import "../libraries/VersionLib.sol";

contract LaunchPoolFactoryV2 is LaunchPoolFactoryUpgradeable {
    using VersionLib for mapping(address => uint256);

    // Add new features for V2
    uint256 public maxProjectsPerOwner;
    mapping(address => uint256) public ownerProjectCount;
    bool public useV2Pools; // Flag to determine which version of pools to create
    address public launchPoolV2Implementation; // V2 implementation address

    // Override internal initialization
    function _init() internal virtual override {
        super._init();
        maxProjectsPerOwner = 2; // Default limit
        useV2Pools = false; // Default to V1 pools
    }

    // Initialize V2
    function initialize(address _launchPoolV2Implementation) external virtual override reinitializer(2) {
        require(_launchPoolV2Implementation != address(0), "Invalid V2 implementation");
        launchPoolV2Implementation = _launchPoolV2Implementation;
        maxProjectsPerOwner = 2; // Set default limit
        // Initialize project counts for existing projects
        uint256 projectCount = nextProjectId;
        for (uint256 i = 0; i < projectCount; i++) {
            address projectOwner = super.getProjectOwner(i);
            if (ownerProjectCount[projectOwner] == 0) {
                ownerProjectCount[projectOwner] = 1;
            } else {
                ownerProjectCount[projectOwner]++;
            }
        }
    }

    // Override internal _createProject to add project count limit
    function _createProject(
        IERC20 _rewardToken,
        uint256 _totalRewardAmount,
        uint32 _startTime,
        uint32 _endTime,
        PoolMetadata calldata _metadata,
        InitialPoolParams[] calldata _initialPools,
        address _projectOwner
    ) internal virtual override returns (uint256) {
        require(
            ownerProjectCount[_projectOwner] < maxProjectsPerOwner,
            "Too many projects"
        );
        
        uint256 projectId = super._createProject(
            _rewardToken,
            _totalRewardAmount,
            _startTime,
            _endTime,
            _metadata,
            _initialPools,
            _projectOwner
        );

        // Update project count after successful creation
        ownerProjectCount[_projectOwner] += 1;
        return projectId;
    }

    // New functions for V2
    function setMaxProjectsPerOwner(uint256 _max) external onlyOwner {
        maxProjectsPerOwner = _max;
    }

    function setUseV2Pools(bool _useV2) external onlyOwner {
        useV2Pools = _useV2;
    }

    /// @dev Prevents renouncing ownership since it would break the factory
    function renounceOwnership() public virtual override onlyOwner {
        revert("Cannot renounce ownership");
    }

    function _deployPool(
        uint256 _projectId,
        IERC20 _stakedToken,
        uint256 _poolRewardAmount,
        uint256 _poolLimitPerUser,
        uint256 _minStakeAmount
    ) internal virtual override returns (address) {
        ProjectToken storage project = projects[_projectId];
        
        bytes32 salt = keccak256(
            abi.encodePacked(_projectId, _stakedToken, project.rewardToken, project.startTime)
        );
        
        address implementation = useV2Pools ? launchPoolV2Implementation : launchPoolImplementation;
        require(implementation != address(0), "Implementation not set");
        
        // Deploy pool using minimal proxy
        address payable launchPoolAddress = payable(Clones.cloneDeterministic(implementation, salt));

        if (useV2Pools) {
            // Initialize V2 pool with default max participants
            LaunchPoolV2(launchPoolAddress).initialize(
                _stakedToken,
                _poolRewardAmount,
                _poolLimitPerUser,
                _minStakeAmount,
                uint32(_projectId),
                100 // Default max participants for V2
            );
        } else {
            // Initialize V1 pool
            LaunchPool(launchPoolAddress).initialize(
                _stakedToken,
                _poolRewardAmount,
                _poolLimitPerUser,
                _minStakeAmount,
                uint32(_projectId)
            );
        }

        // Record pool version
        poolVersions.recordPoolVersion(launchPoolAddress, CURRENT_VERSION);

        project.pools.push(launchPoolAddress);
        emit Events.NewLaunchPool(_projectId, launchPoolAddress, CURRENT_VERSION);
        return launchPoolAddress;
    }
}
