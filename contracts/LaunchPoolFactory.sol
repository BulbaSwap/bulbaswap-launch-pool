// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "./LaunchPool.sol";

contract LaunchPoolFactory is Ownable {
    event NewLaunchPool(address indexed launchPool);

    /**
     * @notice Deploy a pool
     * @param _stakedToken: staked token address
     * @param _rewardToken: reward token address
     * @param _rewardPerSecond: reward per second (in rewardToken)
     * @param _startTime: start time
     * @param _endTime: end time
     * @param _poolLimitPerUser: pool limit per user in stakedToken (if any, else 0)
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
        address _admin
    ) external onlyOwner returns (address) {
        require(_stakedToken.totalSupply() >= 0, "Invalid staked token");
        require(_rewardToken.totalSupply() >= 0, "Invalid reward token");
        require(address(_stakedToken) != address(_rewardToken), "Tokens must be different");
        require(_startTime > block.timestamp, "Start time must be future");
        require(_endTime > _startTime, "End time must be after start time");

        bytes memory bytecode = type(LaunchPool).creationCode;
        bytes32 salt = keccak256(abi.encodePacked(_stakedToken, _rewardToken, _startTime));
        address launchPoolAddress;

        assembly {
            launchPoolAddress := create2(0, add(bytecode, 32), mload(bytecode), salt)
        }

        LaunchPool(launchPoolAddress).initialize(
            _stakedToken,
            _rewardToken,
            _rewardPerSecond,
            _startTime,
            _endTime,
            _poolLimitPerUser,
            _admin
        );

        emit NewLaunchPool(launchPoolAddress);
        return launchPoolAddress;
    }
}
