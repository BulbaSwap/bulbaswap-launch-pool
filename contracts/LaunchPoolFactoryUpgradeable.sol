// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "./LaunchPool.sol";

contract LaunchPoolFactoryUpgradeable is Initializable, OwnableUpgradeable, UUPSUpgradeable {
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

    // Events
    event NewProject(uint256 indexed projectId, address indexed rewardToken, address indexed owner, PoolMetadata metadata);
    event NewLaunchPool(uint256 indexed projectId, address indexed launchPool, uint256 version);
    event ProjectStatusUpdated(uint256 indexed projectId, ProjectStatus status);
    event PoolMetadataUpdated(uint256 indexed projectId, PoolMetadata metadata);
    event PoolFunded(uint256 indexed projectId, address indexed pool);
    event ProjectOwnershipTransferred(uint256 indexed projectId, address indexed previousOwner, address indexed newOwner);
    event FactoryUpgraded(address indexed implementation);

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    function _init() internal virtual {
        __Ownable_init();
        __UUPSUpgradeable_init();
        nextProjectId = 0;
    }

    function initialize() external virtual initializer {
        _init();
    }

    // Required authorization check for UUPS
    function _authorizeUpgrade(address newImplementation) internal override onlyOwner {
        emit FactoryUpgraded(newImplementation);
    }

    // Get pool version
    function getPoolVersion(address pool) external view returns (uint256) {
        require(poolVersions[pool] > 0, "Pool not found");
        return poolVersions[pool];
    }

    // Check if pool was created by factory
    function isPoolFromFactory(address pool) external view returns (bool) {
        return poolVersions[pool] > 0;
    }

    function _deployPool(
        uint256 _projectId,
        IERC20 _stakedToken,
        uint256 _poolRewardAmount,
        uint256 _poolLimitPerUser,
        uint256 _minStakeAmount
    ) internal virtual returns (address) {
        ProjectToken storage project = projects[_projectId];
        require(address(_stakedToken) != address(project.rewardToken), "Tokens must be different");

        bytes32 salt = keccak256(
            abi.encodePacked(_projectId, _stakedToken, project.rewardToken, project.startTime)
        );
        
        // Deploy pool
        LaunchPool launchPool = new LaunchPool{salt: salt}();
        address launchPoolAddress = address(launchPool);

        // Initialize pool
        LaunchPool(launchPoolAddress).initialize(
            _stakedToken,
            _poolRewardAmount,
            _poolLimitPerUser,
            _minStakeAmount,
            _projectId
        );

        // Record pool version
        poolVersions[launchPoolAddress] = CURRENT_VERSION;

        project.pools.push(launchPoolAddress);
        emit NewLaunchPool(_projectId, launchPoolAddress, CURRENT_VERSION);
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
        ProjectToken storage project = projects[_projectId];
        uint256 duration = project.endTime - project.startTime;
        return (_poolRewardAmount + duration - 1) / duration; // Ceiling division
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

    function _createProject(
        IERC20 _rewardToken,
        uint256 _totalRewardAmount,
        uint256 _startTime,
        uint256 _endTime,
        PoolMetadata calldata _metadata,
        InitialPoolParams calldata _initialPool,
        address _projectOwner
    ) internal virtual returns (uint256 projectId) {
        require(_rewardToken.totalSupply() >= 0, "Invalid reward token");
        require(_startTime > block.timestamp, "Start time must be future");
        require(_endTime > _startTime, "End time must be after start time");
        require(_projectOwner != address(0), "Invalid project owner");
        
        projectId = nextProjectId++;
        ProjectToken storage project = projects[projectId];
        
        project.rewardToken = _rewardToken;
        project.totalRewardAmount = _totalRewardAmount;
        project.startTime = _startTime;
        project.endTime = _endTime;
        project.metadata = _metadata;
        project.status = ProjectStatus.STAGING;
        project.owner = _projectOwner;
        
        emit NewProject(projectId, address(_rewardToken), _projectOwner, _metadata);
        emit ProjectStatusUpdated(projectId, ProjectStatus.STAGING);

        // If initial pool parameters are provided, create initial pool
        if (address(_initialPool.stakedToken) != address(0)) {
            require(_initialPool.poolRewardAmount <= _totalRewardAmount, "Pool reward exceeds total");
            
            address poolAddress = _deployPool(
                projectId,
                _initialPool.stakedToken,
                _initialPool.poolRewardAmount,
                _initialPool.poolLimitPerUser,
                _initialPool.minStakeAmount
            );
            
            // Record funding requirement
            project.poolFunded[poolAddress] = false;
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

    struct InitialPoolParams {
        IERC20 stakedToken;
        uint256 poolRewardAmount;
        uint256 poolLimitPerUser;
        uint256 minStakeAmount;
    }

    function updateProjectStatus(uint256 _projectId, ProjectStatus _status) external {
        ProjectToken storage project = projects[_projectId];
        require(msg.sender == project.owner, "Only project owner");
        require(address(project.rewardToken) != address(0), "Project does not exist");
        
        if (_status == ProjectStatus.READY) {
            require(project.status == ProjectStatus.STAGING, "Can only move to READY from STAGING");
            require(project.fundedPoolCount == project.pools.length, "Not all pools funded");
            
            uint256 totalAllocated = 0;
            for (uint256 i = 0; i < project.pools.length; i++) {
                LaunchPool currentPool = LaunchPool(project.pools[i]);
                totalAllocated += currentPool.poolRewardAmount();
            }
            require(totalAllocated == project.totalRewardAmount, "Total allocated rewards must match total");
        } else if (_status == ProjectStatus.DELISTED) {
            require(project.status == ProjectStatus.STAGING || 
                   project.status == ProjectStatus.READY, "Can only delist from STAGING or READY");
        } else if (_status == ProjectStatus.PAUSED) {
            require(project.status == ProjectStatus.READY, "Can only pause from READY state");
        } else if (_status == ProjectStatus.STAGING) {
            require(project.status == ProjectStatus.PAUSED, "Can only move to STAGING from PAUSED");
        }
        
        project.status = _status;
        emit ProjectStatusUpdated(_projectId, _status);
    }

    function updateProjectMetadata(
        uint256 _projectId,
        PoolMetadata calldata _metadata
    ) external {
        ProjectToken storage project = projects[_projectId];
        require(msg.sender == project.owner, "Only project owner");
        require(address(project.rewardToken) != address(0), "Project does not exist");
        project.metadata = _metadata;
        emit PoolMetadataUpdated(_projectId, _metadata);
    }

    function transferProjectOwnership(uint256 _projectId, address _newOwner) external {
        ProjectToken storage project = projects[_projectId];
        require(msg.sender == project.owner, "Only project owner");
        require(_newOwner != address(0), "New owner is zero address");
        
        address oldOwner = project.owner;
        project.owner = _newOwner;
        emit ProjectOwnershipTransferred(_projectId, oldOwner, _newOwner);
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
        ProjectToken storage project = projects[_projectId];
        address[] memory poolAddresses = project.pools;
        PoolInfo[] memory poolInfos = new PoolInfo[](poolAddresses.length);
        
        for (uint256 i = 0; i < poolAddresses.length; i++) {
            LaunchPool currentPool = LaunchPool(poolAddresses[i]);
            poolInfos[i] = PoolInfo({
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

    function fundPool(uint256 _projectId, address _poolAddress, uint256 _amount) external {
        ProjectToken storage project = projects[_projectId];
        require(msg.sender == project.owner, "Only project owner");
        require(address(project.rewardToken) != address(0), "Project does not exist");
        require(project.status == ProjectStatus.STAGING, "Project not in staging");
        require(!project.poolFunded[_poolAddress], "Pool already funded");
        
        LaunchPool launchPool = LaunchPool(_poolAddress);
        require(launchPool.projectId() == _projectId, "Pool not in project");
        require(launchPool.poolRewardAmount() == _amount, "Amount must match pool reward amount");
        
        project.rewardToken.transferFrom(msg.sender, _poolAddress, _amount);
        
        project.poolFunded[_poolAddress] = true;
        project.fundedPoolCount++;
        
        emit PoolFunded(_projectId, _poolAddress);
        
        if (project.fundedPoolCount == project.pools.length) {
            uint256 totalAllocated = 0;
            for (uint256 i = 0; i < project.pools.length; i++) {
                LaunchPool currentPool = LaunchPool(project.pools[i]);
                totalAllocated += currentPool.poolRewardAmount();
            }
            require(totalAllocated == project.totalRewardAmount, "Total allocated rewards must match total");
            
            project.status = ProjectStatus.READY;
            emit ProjectStatusUpdated(_projectId, ProjectStatus.READY);
        }
    }

    struct PoolInfo {
        address poolAddress;
        address stakedToken;
        address rewardToken;
        uint256 rewardPerSecond;
        uint256 startTime;
        uint256 endTime;
        uint256 poolLimitPerUser;
        uint256 minStakeAmount;
    }
}
