// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import "@openzeppelin/contracts/proxy/Clones.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "./LaunchPool.sol";
import "./libraries/ProjectLib.sol";
import "./libraries/PoolLib.sol";
import "./libraries/VersionLib.sol";
import "./libraries/Events.sol";

contract LaunchPoolFactoryUpgradeable is Initializable, OwnableUpgradeable, UUPSUpgradeable {
    using ProjectLib for mapping(uint256 => ProjectToken);
    using PoolLib for mapping(uint256 => ProjectToken);
    using VersionLib for mapping(address => uint256);

    // Version management
    uint256 public constant CURRENT_VERSION = 1;
    mapping(address => uint256) public poolVersions;
    
    struct PoolMetadata {
        string projectName;
        string website;
        string logo;
        string discord;
        string twitter;
        string telegram;
        string tokenInfo;
    }

    enum ProjectStatus {
        STAGING,
        READY,
        DELISTED,
        PAUSED
    }

    struct ProjectToken {
        IERC20 rewardToken;
        uint256 totalRewardAmount;
        uint256 startTime;
        uint256 endTime;
        ProjectStatus status;
        address[] pools;
        mapping(address => bool) poolFunded;
        uint256 fundedPoolCount;
        PoolMetadata metadata;
        address owner;
    }

    // Storage variables
    mapping(uint256 => ProjectToken) public projects;
    uint256 public nextProjectId;
    
    // LaunchPool implementation address
    address public launchPoolImplementation;

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    function _init() internal virtual {
        __Ownable_init();
        __UUPSUpgradeable_init();
        nextProjectId = 0;
    }

    function initialize(address _launchPoolImplementation) external virtual initializer {
        _init();
        require(_launchPoolImplementation != address(0), "Invalid implementation");
        launchPoolImplementation = _launchPoolImplementation;
    }

    // Required authorization check for UUPS
    function _authorizeUpgrade(address newImplementation) internal override onlyOwner {
        VersionLib.authorizeUpgrade(newImplementation);
    }

    // Get pool version
    function getPoolVersion(address pool) external view returns (uint256) {
        return poolVersions.getPoolVersion(pool);
    }

    // Check if pool was created by factory
    function isPoolFromFactory(address pool) external view returns (bool) {
        return poolVersions.isPoolFromFactory(pool);
    }

    function _deployPool(
        uint256 _projectId,
        IERC20 _stakedToken,
        uint256 _poolRewardAmount,
        uint256 _poolLimitPerUser,
        uint256 _minStakeAmount
    ) internal virtual returns (address) {
        ProjectToken storage project = projects[_projectId];
        
        // Special handling for ETH pools
        if (address(_stakedToken) != 0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE) {
            require(address(_stakedToken) != address(project.rewardToken), "Tokens must be different");
        }

        bytes32 salt = keccak256(
            abi.encodePacked(_projectId, _stakedToken, project.rewardToken, project.startTime)
        );
        
        require(launchPoolImplementation != address(0), "Implementation not set");
        
        // Deploy pool using minimal proxy
        address payable launchPoolAddress = payable(Clones.cloneDeterministic(launchPoolImplementation, salt));

        // Initialize pool
        LaunchPool(launchPoolAddress).initialize(
            _stakedToken,
            _poolRewardAmount,
            _poolLimitPerUser,
            _minStakeAmount,
            _projectId
        );

        // Record pool version
        poolVersions.recordPoolVersion(launchPoolAddress, CURRENT_VERSION);

        project.pools.push(launchPoolAddress);
        emit Events.NewLaunchPool(_projectId, launchPoolAddress, CURRENT_VERSION);
        return launchPoolAddress;
    }

    function getProjectRewardToken(uint256 _projectId) external view returns (IERC20) {
        return projects[_projectId].rewardToken;
    }

    function getProjectTimes(uint256 _projectId) external view returns (uint256 startTime, uint256 endTime) {
        ProjectToken storage project = projects[_projectId];
        return (project.startTime, project.endTime);
    }

    function calculateRewardPerSecond(uint256 _projectId, uint256 _poolRewardAmount) public view returns (uint256) {
        return projects.calculateRewardPerSecond(_projectId, _poolRewardAmount);
    }

    function getProjectStatus(uint256 _projectId) public view returns (string memory) {
        ProjectToken storage project = projects[_projectId];
        
        if (project.status == ProjectStatus.DELISTED) {
            return "DELISTED";
        }
        if (project.status == ProjectStatus.PAUSED) {
            return "PAUSED";
        }
        
        if (project.status == ProjectStatus.READY) {
            if (block.timestamp >= project.endTime) {
                return "ENDED";
            }
            if (block.timestamp >= project.startTime) {
                return "ACTIVE";
            }
            return "READY";
        }
        
        return "STAGING";
    }

    function isProjectActive(uint256 _projectId) public view returns (bool) {
        ProjectToken storage project = projects[_projectId];
        return project.status == ProjectStatus.READY &&
               block.timestamp >= project.startTime &&
               block.timestamp < project.endTime;
    }

    struct InitialPoolParams {
        IERC20[] stakedTokens;
        uint256[] poolRewardAmounts;
        uint256[] poolLimitPerUsers;
        uint256[] minStakeAmounts;
    }

    function _validateInitialPools(
        InitialPoolParams calldata _initialPool,
        uint256 _totalRewardAmount
    ) internal pure {
        // Check array lengths match
        require(
            _initialPool.stakedTokens.length == _initialPool.poolRewardAmounts.length &&
            _initialPool.stakedTokens.length == _initialPool.poolLimitPerUsers.length &&
            _initialPool.stakedTokens.length == _initialPool.minStakeAmounts.length,
            "Array lengths must match"
        );

        // Calculate total reward amount
        uint256 totalPoolRewards;
        for (uint256 i = 0; i < _initialPool.poolRewardAmounts.length; i++) {
            totalPoolRewards += _initialPool.poolRewardAmounts[i];
        }
        require(totalPoolRewards <= _totalRewardAmount, "Pool rewards exceed total");
    }

    function _createProject(
        IERC20 _rewardToken,
        uint256 _totalRewardAmount,
        uint256 _startTime,
        uint256 _endTime,
        PoolMetadata calldata _metadata,
        InitialPoolParams calldata _initialPool,
        address _projectOwner
    ) internal virtual returns (uint256) {
        // Validate initial pools if any
        if (_initialPool.stakedTokens.length > 0) {
            _validateInitialPools(_initialPool, _totalRewardAmount);
        }

        uint256 projectId = projects.createProject(
            nextProjectId,
            _rewardToken,
            _totalRewardAmount,
            _startTime,
            _endTime,
            _metadata,
            _projectOwner
        );
        
        nextProjectId++;

        // Create initial pools if provided
        for (uint256 i = 0; i < _initialPool.stakedTokens.length; i++) {
            address poolAddress = _deployPool(
                projectId,
                _initialPool.stakedTokens[i],
                _initialPool.poolRewardAmounts[i],
                _initialPool.poolLimitPerUsers[i],
                _initialPool.minStakeAmounts[i]
            );
            
            // Record funding requirement
            projects[projectId].poolFunded[poolAddress] = false;
        }
        
        return projectId;
    }

    function createProject(
        IERC20 _rewardToken,
        uint256 _totalRewardAmount,
        uint256 _startTime,
        uint256 _endTime,
        PoolMetadata calldata _metadata,
        InitialPoolParams calldata _initialPool,
        address _projectOwner
    ) external onlyOwner returns (uint256) {
        return _createProject(
            _rewardToken,
            _totalRewardAmount,
            _startTime,
            _endTime,
            _metadata,
            _initialPool,
            _projectOwner
        );
    }

    function updateProjectStatus(uint256 _projectId, ProjectStatus _status) external {
        require(msg.sender == projects[_projectId].owner, "Only project owner");
        projects.updateProjectStatus(_projectId, _status);
    }

    function updateProjectMetadata(
        uint256 _projectId,
        PoolMetadata calldata _metadata
    ) external {
        require(msg.sender == projects[_projectId].owner, "Only project owner");
        projects.updateProjectMetadata(_projectId, _metadata);
    }

    function transferProjectOwnership(uint256 _projectId, address _newOwner) external {
        require(msg.sender == projects[_projectId].owner, "Only project owner");
        projects.transferProjectOwnership(_projectId, _newOwner);
    }

    function getProjectOwner(uint256 _projectId) public virtual view returns (address) {
        return projects[_projectId].owner;
    }

    function isProjectOwner(uint256 _projectId, address _address) public view returns (bool) {
        return projects[_projectId].owner == _address;
    }

    function addPoolToProject(
        uint256 _projectId,
        IERC20 _stakedToken,
        uint256 _poolRewardAmount,
        uint256 _poolLimitPerUser,
        uint256 _minStakeAmount
    ) external returns (address) {
        ProjectToken storage project = projects[_projectId];
        require(msg.sender == project.owner, "Only project owner");
        require(address(project.rewardToken) != address(0), "Project does not exist");
        require(project.status == ProjectStatus.STAGING, "Project not in staging");
        require(_poolRewardAmount <= project.totalRewardAmount, "Pool reward exceeds total");
        
        return _deployPool(
            _projectId,
            _stakedToken,
            _poolRewardAmount,
            _poolLimitPerUser,
            _minStakeAmount
        );
    }

    function getProjectPools(uint256 _projectId) external view returns (PoolInfo[] memory) {
        return projects.getProjectPools(_projectId);
    }

    /// @dev Prevents renouncing ownership since it would break the factory
    function renounceOwnership() public virtual override onlyOwner {
        revert("Cannot renounce ownership");
    }

    function fundPool(uint256 _projectId, address payable _poolAddress, uint256 _amount) external {
        require(msg.sender == projects[_projectId].owner, "Only project owner");
        projects.fundPool(_projectId, _poolAddress, _amount);
    }

    struct PoolInfo {
        address payable poolAddress;
        address stakedToken;
        address rewardToken;
        uint256 rewardPerSecond;
        uint256 startTime;
        uint256 endTime;
        uint256 poolLimitPerUser;
        uint256 minStakeAmount;
    }
}
