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

    event NewLaunchPool(address indexed launchPool, PoolMetadata metadata);
    event PoolMetadataUpdated(address indexed launchPool, PoolMetadata metadata);

    /**
     * @notice Deploy a pool
     * @param _stakedToken: staked token address
     * @param _rewardToken: reward token address
     * @param _rewardPerSecond: reward per second (in rewardToken)
     * @param _startTime: start time
     * @param _endTime: end time
     * @param _poolLimitPerUser: pool limit per user in stakedToken (if any, else 0)
     * @param _minStakeAmount: minimum amount that can be staked
     * @param _metadata: pool metadata including project info and social links
     * @param _admin: admin address with ownership
     * @return address of new launch pool contract
     */
    function deployPool(
        IERC20 _stakedToken,
        IERC20 _rewardToken,
        uint256 _rewardPerSecond,
        uint256 _startTime,
        uint256 _endTime,
        uint256 _poolLimitPerUser,
        uint256 _minStakeAmount,
        PoolMetadata calldata _metadata,
        address _admin
    ) external onlyOwner returns (address) {
        require(_stakedToken.totalSupply() >= 0, "Invalid staked token");
        require(_rewardToken.totalSupply() >= 0, "Invalid reward token");
        require(address(_stakedToken) != address(_rewardToken), "Tokens must be different");
        require(_startTime > block.timestamp, "Start time must be future");
        require(_endTime > _startTime, "End time must be after start time");

        bytes32 salt = keccak256(abi.encodePacked(_stakedToken, _rewardToken, _startTime));
        LaunchPool launchPool = new LaunchPool{salt: salt}();
        address launchPoolAddress = address(launchPool);

        LaunchPool(launchPoolAddress).initialize(
            _stakedToken,
            _rewardToken,
            _rewardPerSecond,
            _startTime,
            _endTime,
            _poolLimitPerUser,
            _minStakeAmount,
            _admin
        );

        emit NewLaunchPool(launchPoolAddress, _metadata);
        return launchPoolAddress;
    }

    function updatePoolMetadata(
        address _launchPool,
        PoolMetadata calldata _metadata
    ) external onlyOwner {
        require(_launchPool != address(0), "Invalid pool address");
        emit PoolMetadataUpdated(_launchPool, _metadata);
    }
}
