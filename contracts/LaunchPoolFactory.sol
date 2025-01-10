// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "./LaunchPool.sol";

contract LaunchPoolFactory is Ownable {
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
        STAGING,    // Initial state, can add pools and fund them
        READY,      // Funding completed, ready to start
        DELISTED,   // Project delisted
        PAUSED      // Project paused
    }

    struct ProjectToken {
        IERC20 rewardToken;          // Project reward token
        uint256 totalRewardAmount;   // Total amount of tokens to be distributed
        uint256 startTime;           // Project start time
        uint256 endTime;             // Project end time
        ProjectStatus status;        // Project status
        address[] pools;             // All pool addresses in the project
        mapping(address => bool) poolFunded;  // Whether pool is funded
        uint256 fundedPoolCount;     // Number of funded pools
        PoolMetadata metadata;       // Project metadata
        address owner;               // Project owner address
    }

    // Project mapping
    mapping(uint256 => ProjectToken) public projects;
    uint256 public nextProjectId;

    event NewProject(uint256 indexed projectId, address indexed rewardToken, address indexed owner, PoolMetadata metadata);
    event NewLaunchPool(uint256 indexed projectId, address indexed launchPool);
    event ProjectStatusUpdated(uint256 indexed projectId, ProjectStatus status);
    event PoolMetadataUpdated(uint256 indexed projectId, PoolMetadata metadata);
    event PoolFunded(uint256 indexed projectId, address indexed pool);
    event ProjectOwnershipTransferred(uint256 indexed projectId, address indexed previousOwner, address indexed newOwner);

    // Function to query project status
    function getProjectStatus(uint256 _projectId) public view returns (string memory) {
        ProjectToken storage project = projects[_projectId];
        
        if (project.status == ProjectStatus.DELISTED) {
            return "DELISTED";
        }
        if (project.status == ProjectStatus.PAUSED) {
            return "PAUSED";
        }
        
        // Only READY state can transition to ACTIVE or ENDED
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

    // Check if project is active
    function isProjectActive(uint256 _projectId) public view returns (bool) {
        ProjectToken storage project = projects[_projectId];
        return project.status == ProjectStatus.READY &&
               block.timestamp >= project.startTime &&
               block.timestamp < project.endTime;
    }

    /**
     * @notice Create a new project with optional initial pool
     */
    function createProject(
        IERC20 _rewardToken,
        uint256 _totalRewardAmount,
        uint256 _startTime,
        uint256 _endTime,
        PoolMetadata calldata _metadata,
        InitialPoolParams calldata _initialPool,
        address _projectOwner
    ) external onlyOwner returns (uint256 projectId) {
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
            
            // Calculate reward per second with ceiling division to ensure complete distribution
            uint256 duration = _endTime - _startTime;
            uint256 rewardPerSecond = (_initialPool.poolRewardAmount + duration - 1) / duration;
            
            address poolAddress = _deployPool(
                projectId,
                _initialPool.stakedToken,
                rewardPerSecond,
                _initialPool.poolLimitPerUser,
                _initialPool.minStakeAmount
            );
            
            // Record funding requirement
            project.poolFunded[poolAddress] = false;
        }
        
        return projectId;
    }

    /**
     * @notice Add a new pool to existing project
     */
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

        // Calculate reward per second with ceiling division to ensure complete distribution
        uint256 duration = project.endTime - project.startTime;
        uint256 rewardPerSecond = (_poolRewardAmount + duration - 1) / duration;
        
        return _deployPool(
            _projectId,
            _stakedToken,
            rewardPerSecond,
            _poolLimitPerUser,
            _minStakeAmount
        );
    }

    /**
     * @notice Internal function to deploy a new pool
     */
    function _deployPool(
        uint256 _projectId,
        IERC20 _stakedToken,
        uint256 _rewardPerSecond,
        uint256 _poolLimitPerUser,
        uint256 _minStakeAmount
    ) internal returns (address) {
        ProjectToken storage project = projects[_projectId];
        require(address(_stakedToken) != address(project.rewardToken), "Tokens must be different");

        bytes32 salt = keccak256(
            abi.encodePacked(_projectId, _stakedToken, project.rewardToken, project.startTime)
        );
        LaunchPool launchPool = new LaunchPool{salt: salt}();
        address launchPoolAddress = address(launchPool);

        LaunchPool(launchPoolAddress).initialize(
            _stakedToken,
            project.rewardToken,
            _rewardPerSecond,
            project.startTime,
            project.endTime,
            _poolLimitPerUser,
            _minStakeAmount,
            _projectId
        );

        project.pools.push(launchPoolAddress);
        emit NewLaunchPool(_projectId, launchPoolAddress);
        return launchPoolAddress;
    }

    /**
     * @notice Update project status
     */
    function updateProjectStatus(uint256 _projectId, ProjectStatus _status) external {
        ProjectToken storage project = projects[_projectId];
        require(msg.sender == project.owner, "Only project owner");
        require(address(project.rewardToken) != address(0), "Project does not exist");
        
        // Validate status transition
        if (_status == ProjectStatus.READY) {
            require(project.status == ProjectStatus.STAGING, "Can only move to READY from STAGING");
            require(project.fundedPoolCount == project.pools.length, "Not all pools funded");
            
            // Calculate total rewards allocated to all pools
            uint256 totalAllocated = 0;
            for (uint256 i = 0; i < project.pools.length; i++) {
                LaunchPool currentPool = LaunchPool(project.pools[i]);
                totalAllocated += currentPool.rewardPerSecond() * (project.endTime - project.startTime);
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

    /**
     * @notice Update project metadata
     */
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

    /**
     * @notice Transfer project ownership
     */
    function transferProjectOwnership(uint256 _projectId, address _newOwner) external {
        ProjectToken storage project = projects[_projectId];
        require(msg.sender == project.owner, "Only project owner");
        require(_newOwner != address(0), "New owner is zero address");
        
        address oldOwner = project.owner;
        project.owner = _newOwner;
        emit ProjectOwnershipTransferred(_projectId, oldOwner, _newOwner);
    }

    /**
     * @notice Get project owner
     */
    function getProjectOwner(uint256 _projectId) external view returns (address) {
        return projects[_projectId].owner;
    }

    /**
     * @notice Check if sender is project owner
     */
    function isProjectOwner(uint256 _projectId, address _address) public view returns (bool) {
        return projects[_projectId].owner == _address;
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

    /**
     * @notice Get all pools in a project with their information
     */
    function getProjectPools(uint256 _projectId) external view returns (PoolInfo[] memory) {
        ProjectToken storage project = projects[_projectId];
        address[] memory poolAddresses = project.pools;
        PoolInfo[] memory poolInfos = new PoolInfo[](poolAddresses.length);
        
        for (uint256 i = 0; i < poolAddresses.length; i++) {
            LaunchPool currentPool = LaunchPool(poolAddresses[i]);
            poolInfos[i] = PoolInfo({
                poolAddress: poolAddresses[i],
                stakedToken: address(currentPool.stakedToken()),
                rewardToken: address(currentPool.rewardToken()),
                rewardPerSecond: currentPool.rewardPerSecond(),
                startTime: currentPool.startTime(),
                endTime: currentPool.endTime(),
                poolLimitPerUser: currentPool.poolLimitPerUser(),
                minStakeAmount: currentPool.minStakeAmount()
            });
        }
        
        return poolInfos;
    }

    /**
     * @notice Calculate reward per second for a given reward amount and duration
     */
    function calculateRewardPerSecond(
        uint256 _poolRewardAmount,
        uint256 _startTime,
        uint256 _endTime
    ) public pure returns (uint256) {
        require(_endTime > _startTime, "End time must be after start time");
        uint256 duration = _endTime - _startTime;
        return (_poolRewardAmount + duration - 1) / duration;
    }

    /**
     * @notice Fund a pool with reward tokens
     */
    function fundPool(uint256 _projectId, address _poolAddress, uint256 _amount) external {
        ProjectToken storage project = projects[_projectId];
        require(msg.sender == project.owner, "Only project owner");
        require(address(project.rewardToken) != address(0), "Project does not exist");
        require(project.status == ProjectStatus.STAGING, "Project not in staging");
        require(!project.poolFunded[_poolAddress], "Pool already funded");
        
        LaunchPool launchPool = LaunchPool(_poolAddress);
        require(launchPool.projectId() == _projectId, "Pool not in project");
        
        // Transfer reward tokens to pool
        project.rewardToken.transferFrom(msg.sender, _poolAddress, _amount);
        
        project.poolFunded[_poolAddress] = true;
        project.fundedPoolCount++;
        
        emit PoolFunded(_projectId, _poolAddress);
        
        // If all pools are funded, automatically transition to READY state
        if (project.fundedPoolCount == project.pools.length) {
            // Calculate total rewards allocated to all pools
            uint256 totalAllocated = 0;
            for (uint256 i = 0; i < project.pools.length; i++) {
                LaunchPool currentPool = LaunchPool(project.pools[i]);
                totalAllocated += currentPool.rewardPerSecond() * (project.endTime - project.startTime);
            }
            require(totalAllocated == project.totalRewardAmount, "Total allocated rewards must match total");
            
            project.status = ProjectStatus.READY;
            emit ProjectStatusUpdated(_projectId, ProjectStatus.READY);
        }
    }

    /**
     * @notice Helper struct for initial pool creation
     */
    struct InitialPoolParams {
        IERC20 stakedToken;
        uint256 poolRewardAmount;    // Total reward amount for the pool
        uint256 poolLimitPerUser;
        uint256 minStakeAmount;
    }
}
