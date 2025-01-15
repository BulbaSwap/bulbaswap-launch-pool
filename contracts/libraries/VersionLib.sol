// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import "./Events.sol";

library VersionLib {
    function getPoolVersion(
        mapping(address => uint256) storage poolVersions,
        address pool
    ) internal view returns (uint256) {
        require(poolVersions[pool] > 0, "Pool not found");
        return poolVersions[pool];
    }

    function isPoolFromFactory(
        mapping(address => uint256) storage poolVersions,
        address pool
    ) internal view returns (bool) {
        return poolVersions[pool] > 0;
    }

    function recordPoolVersion(
        mapping(address => uint256) storage poolVersions,
        address pool,
        uint256 version
    ) internal {
        poolVersions[pool] = version;
    }

    function authorizeUpgrade(
        address newImplementation
    ) internal {
        emit Events.FactoryUpgraded(newImplementation);
    }
}
