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
    using ProjectLib for mapping(uint32 => ProjectToken);
    using PoolLib for mapping(uint32 => ProjectToken);
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
        uint32 startTime;
        uint32 endTime;
        ProjectStatus status;
        address[] pools;
        mapping(address => bool) poolFunded;
        uint16 fundedPoolCount;
        PoolMetadata metadata;
        address owner;
    }

    // Storage variables
    mapping(uint32 => ProjectToken) public projects;
    uint32 public nextProjectId;
    
    // LaunchPool implementation address
    address public launchPoolImplementation;

    // Counter for unique pool deployment
    uint256 private _poolNonce;

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
        uint32 _projectId,
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
            abi.encodePacked(_projectId, _stakedToken, project.rewardToken, project.startTime, _poolNonce++)
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

    // Project information struct for frontend
    struct ProjectInfo {
        IERC20 rewardToken;
        uint256 totalRewardAmount;
        uint32 startTime;
        uint32 endTime;
        ProjectStatus status;
        address[] pools;
        PoolMetadata metadata;
        address owner;
        PoolInfo[] poolInfos;
        string currentStatus;
        bool isActive;
    }

    // Get complete project information
    function getProject(uint32 _projectId) external view returns (ProjectInfo memory) {
        ProjectToken storage project = projects[_projectId];
        
        string memory currentStatus = _getProjectStatus(_projectId);
        bool isActive = keccak256(bytes(currentStatus)) == keccak256(bytes("ACTIVE"));

        return ProjectInfo({
            rewardToken: project.rewardToken,
            totalRewardAmount: project.totalRewardAmount,
            startTime: project.startTime,
            endTime: project.endTime,
            status: project.status,
            pools: project.pools,
            metadata: project.metadata,
            owner: project.owner,
            poolInfos: projects.getProjectPools(_projectId),
            currentStatus: currentStatus,
            isActive: isActive
        });
    }

    // Internal functions used by LaunchPool contract
    function _getProjectRewardToken(uint32 _projectId) internal view returns (IERC20) {
        return projects[_projectId].rewardToken;
    }

    function _getProjectTimes(uint32 _projectId) internal view returns (uint32 startTime, uint32 endTime) {
        ProjectToken storage project = projects[_projectId];
        return (project.startTime, project.endTime);
    }

    function _getProjectStatus(uint32 _projectId) internal view returns (string memory) {
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

    // External functions needed by LaunchPool contract
    function getProjectRewardToken(uint32 _projectId) external view returns (IERC20) {
        return _getProjectRewardToken(_projectId);
    }

    function getProjectTimes(uint32 _projectId) external view returns (uint32 startTime, uint32 endTime) {
        return _getProjectTimes(_projectId);
    }

    function getProjectStatus(uint32 _projectId) external view returns (string memory) {
        return _getProjectStatus(_projectId);
    }

    function calculateRewardPerSecond(uint32 _projectId, uint256 _poolRewardAmount) public view returns (uint256) {
        return projects.calculateRewardPerSecond(_projectId, _poolRewardAmount);
    }

    struct InitialPoolParams {
        IERC20 stakedToken;
        uint256 poolRewardAmount;
        uint256 poolLimitPerUser;
        uint256 minStakeAmount;
    }

    function _validateInitialPools(
        InitialPoolParams[] calldata _pools,
        uint256 _totalRewardAmount
    ) internal pure {
        // Calculate total reward amount
        uint256 totalPoolRewards;
        for (uint256 i = 0; i < _pools.length; i++) {
            totalPoolRewards += _pools[i].poolRewardAmount;
        }
        require(totalPoolRewards <= _totalRewardAmount, "Pool rewards exceed total");
    }

    function _createProject(
        IERC20 _rewardToken,
        uint256 _totalRewardAmount,
        uint32 _startTime,
        uint32 _endTime,
        PoolMetadata calldata _metadata,
        InitialPoolParams[] calldata _pools,
        address _projectOwner
    ) internal virtual returns (uint32) {
        // Validate initial pools if any
        if (_pools.length > 0) {
            _validateInitialPools(_pools, _totalRewardAmount);
        }

        uint32 projectId = projects.createProject(
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
        for (uint256 i = 0; i < _pools.length; i++) {
            address poolAddress = _deployPool(
                projectId,
                _pools[i].stakedToken,
                _pools[i].poolRewardAmount,
                _pools[i].poolLimitPerUser,
                _pools[i].minStakeAmount
            );
            
            // Record funding requirement
            projects[projectId].poolFunded[poolAddress] = false;
        }
        
        return projectId;
    }

    function createProject(
        IERC20 _rewardToken,
        uint256 _totalRewardAmount,
        uint32 _startTime,
        uint32 _endTime,
        PoolMetadata calldata _metadata,
        InitialPoolParams[] calldata _pools,
        address _projectOwner
    ) external onlyOwner returns (uint32) {
        return _createProject(
            _rewardToken,
            _totalRewardAmount,
            _startTime,
            _endTime,
            _metadata,
            _pools,
            _projectOwner
        );
    }

    function updateProjectStatus(uint32 _projectId, ProjectStatus _status) external {
        require(msg.sender == projects[_projectId].owner, "Only project owner");
        projects.updateProjectStatus(_projectId, _status);
    }

    function pauseProject(uint32 _projectId) external {
        require(msg.sender == projects[_projectId].owner, "Only project owner");
        projects.updateProjectStatus(_projectId, ProjectStatus.PAUSED);
    }

    function resumeProject(uint32 _projectId) external {
        require(msg.sender == projects[_projectId].owner, "Only project owner");
        ProjectToken storage project = projects[_projectId];
        require(project.status == ProjectStatus.PAUSED, "Project not paused");
        
        // Check if all pools have sufficient funds
        bool sufficientFunds = true;
        uint256 totalAllocated = 0;
        
        for (uint256 i = 0; i < project.pools.length; i++) {
            LaunchPool currentPool = LaunchPool(payable(project.pools[i]));
            uint256 poolRewardAmount = currentPool.poolRewardAmount();
            totalAllocated += poolRewardAmount;
            
            if (IERC20(project.rewardToken).balanceOf(project.pools[i]) < poolRewardAmount) {
                sufficientFunds = false;
                break;
            }
        }
        
        if (sufficientFunds && totalAllocated == project.totalRewardAmount) {
            // If funds are sufficient, directly resume to READY
            projects.updateProjectStatus(_projectId, ProjectStatus.READY);
        } else {
            // If funds are insufficient, move to STAGING
            projects.updateProjectStatus(_projectId, ProjectStatus.STAGING);
        }
    }

    function delistProject(uint32 _projectId) external {
        require(msg.sender == projects[_projectId].owner, "Only project owner");
        projects.updateProjectStatus(_projectId, ProjectStatus.DELISTED);
    }

    function updateProjectMetadata(
        uint32 _projectId,
        PoolMetadata calldata _metadata
    ) external {
        require(msg.sender == projects[_projectId].owner, "Only project owner");
        projects.updateProjectMetadata(_projectId, _metadata);
    }

    function transferProjectOwnership(uint32 _projectId, address _newOwner) external {
        require(msg.sender == projects[_projectId].owner, "Only project owner");
        projects.transferProjectOwnership(_projectId, _newOwner);
    }

    function getProjectOwner(uint32 _projectId) public virtual view returns (address) {
        return projects[_projectId].owner;
    }

    function isProjectOwner(uint32 _projectId, address _address) public view returns (bool) {
        return getProjectOwner(_projectId) == _address;
    }

    function addPoolToProject(
        uint32 _projectId,
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

    function getProjectPools(uint32 _projectId) external view returns (PoolInfo[] memory) {
        return projects.getProjectPools(_projectId);
    }

    function endProject(uint32 _projectId) external {
        require(msg.sender == projects[_projectId].owner, "Not project owner");
        ProjectToken storage project = projects[_projectId];
        require(
            project.status == ProjectStatus.READY,
            "Project not in ready state"
        );
        project.endTime = uint32(block.timestamp);
        emit Events.ProjectStatusUpdated(_projectId, project.status);
    }

    /// @dev Prevents renouncing ownership since it would break the factory
    function renounceOwnership() public virtual override onlyOwner {
        revert("Cannot renounce ownership");
    }

    function fundPool(uint32 _projectId, address payable _poolAddress, uint256 _amount) external {
        require(msg.sender == projects[_projectId].owner, "Only project owner");
        projects.fundPool(_projectId, _poolAddress, _amount);
    }

    struct PoolInfo {
        address payable poolAddress;
        address stakedToken;
        address rewardToken;
        uint256 rewardPerSecond;
        uint32 startTime;
        uint32 endTime;
        uint256 poolLimitPerUser;
        uint256 minStakeAmount;
    }
}
