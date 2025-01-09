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
    }

    // Project mapping
    mapping(uint256 => ProjectToken) public projects;
    uint256 public nextProjectId;

    event NewProject(uint256 indexed projectId, address indexed rewardToken, PoolMetadata metadata);
    event NewLaunchPool(uint256 indexed projectId, address indexed launchPool);
    event ProjectStatusUpdated(uint256 indexed projectId, ProjectStatus status);
    event PoolMetadataUpdated(uint256 indexed projectId, PoolMetadata metadata);
    event PoolFunded(uint256 indexed projectId, address indexed pool);

    /**
     * @notice Create a new project with optional initial pool
     * @param _rewardToken: project reward token address
     * @param _totalRewardAmount: total amount of reward tokens to be distributed
     * @param _startTime: project start time
     * @param _endTime: project end time
     * @param _metadata: project metadata
     * @param _initialPool: optional initial pool parameters
     * @return projectId The ID of the new project
     */
    function createProject(
        IERC20 _rewardToken,
        uint256 _totalRewardAmount,
        uint256 _startTime,
        uint256 _endTime,
        PoolMetadata calldata _metadata,
        InitialPoolParams calldata _initialPool
    ) external onlyOwner returns (uint256 projectId) {
        require(_rewardToken.totalSupply() >= 0, "Invalid reward token");
        require(_startTime > block.timestamp, "Start time must be future");
        require(_endTime > _startTime, "End time must be after start time");
        
        projectId = nextProjectId++;
        ProjectToken storage project = projects[projectId];
        
        project.rewardToken = _rewardToken;
        project.totalRewardAmount = _totalRewardAmount;
        project.startTime = _startTime;
        project.endTime = _endTime;
        project.metadata = _metadata;
        project.status = ProjectStatus.STAGING;
        
        emit NewProject(projectId, address(_rewardToken), _metadata);
        emit ProjectStatusUpdated(projectId, ProjectStatus.STAGING);

        // If initial pool parameters are provided, create initial pool
        if (address(_initialPool.stakedToken) != address(0)) {
            address poolAddress = _deployPool(
                projectId,
                _initialPool.stakedToken,
                _initialPool.rewardPerSecond,
                _initialPool.poolLimitPerUser,
                _initialPool.minStakeAmount,
                _initialPool.admin
            );

            // Calculate required reward tokens for this pool
            uint256 poolDuration = _endTime - _startTime;
            uint256 poolRewardAmount = poolDuration * _initialPool.rewardPerSecond;
            require(poolRewardAmount <= _totalRewardAmount, "Pool reward exceeds total");
            
            // Record funding requirement
            project.poolFunded[poolAddress] = false;
        }
        
        return projectId;
    }

    /**
     * @notice Add a new pool to existing project
     * @param _projectId: ID of the project
     * @param _stakedToken: staked token address
     * @param _rewardPerSecond: reward per second (in rewardToken)
     * @param _poolLimitPerUser: pool limit per user in stakedToken (if any, else 0)
     * @param _minStakeAmount: minimum amount that can be staked
     * @param _admin: admin address with ownership
     * @return address of new launch pool contract
     */
    function addPoolToProject(
        uint256 _projectId,
        IERC20 _stakedToken,
        uint256 _rewardPerSecond,
        uint256 _poolLimitPerUser,
        uint256 _minStakeAmount,
        address _admin
    ) external onlyOwner returns (address) {
        ProjectToken storage project = projects[_projectId];
        require(address(project.rewardToken) != address(0), "Project does not exist");
        require(project.status == ProjectStatus.STAGING, "Project not in staging");
        
        return _deployPool(
            _projectId,
            _stakedToken,
            _rewardPerSecond,
            _poolLimitPerUser,
            _minStakeAmount,
            _admin
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
        uint256 _minStakeAmount,
        address _admin
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
            _projectId,
            _admin
        );

        project.pools.push(launchPoolAddress);
        emit NewLaunchPool(_projectId, launchPoolAddress);
        return launchPoolAddress;
    }

    /**
     * @notice Update project status
     */
    function updateProjectStatus(uint256 _projectId, ProjectStatus _status) external onlyOwner {
        ProjectToken storage project = projects[_projectId];
        require(address(project.rewardToken) != address(0), "Project does not exist");
        
        // Validate status transition
        if (_status == ProjectStatus.READY) {
            require(project.status == ProjectStatus.STAGING, "Can only move to READY from STAGING");
            require(project.fundedPoolCount == project.pools.length, "Not all pools funded");
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
    ) external onlyOwner {
        require(address(projects[_projectId].rewardToken) != address(0), "Project does not exist");
        projects[_projectId].metadata = _metadata;
        emit PoolMetadataUpdated(_projectId, _metadata);
    }

    /**
     * @notice Get all pools in a project
     */
    function getProjectPools(uint256 _projectId) external view returns (address[] memory) {
        return projects[_projectId].pools;
    }

    /**
     * @notice Fund a pool with reward tokens
     */
    function fundPool(uint256 _projectId, address _poolAddress, uint256 _amount) external onlyOwner {
        ProjectToken storage project = projects[_projectId];
        require(address(project.rewardToken) != address(0), "Project does not exist");
        require(project.status == ProjectStatus.STAGING, "Project not in staging");
        require(!project.poolFunded[_poolAddress], "Pool already funded");
        
        LaunchPool pool = LaunchPool(_poolAddress);
        require(pool.projectId() == _projectId, "Pool not in project");
        
        // Transfer reward tokens to pool
        project.rewardToken.transferFrom(msg.sender, _poolAddress, _amount);
        
        project.poolFunded[_poolAddress] = true;
        project.fundedPoolCount++;
        
        emit PoolFunded(_projectId, _poolAddress);
        
        // If all pools are funded, automatically transition to READY state
        if (project.fundedPoolCount == project.pools.length) {
            project.status = ProjectStatus.READY;
            emit ProjectStatusUpdated(_projectId, ProjectStatus.READY);
        }
    }

    /**
     * @notice Helper struct for initial pool creation
     */
    struct InitialPoolParams {
        IERC20 stakedToken;
        uint256 rewardPerSecond;
        uint256 poolLimitPerUser;
        uint256 minStakeAmount;
        address admin;
    }
}
