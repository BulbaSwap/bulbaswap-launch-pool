// LaunchPool constructor parameters
module.exports = [
  "0x...", // stakedToken - staked token address
  "0x...", // rewardToken - reward token address
  "1000000000000000000", // rewardPerSecond - 1 token per second (18 decimals)
  "1735689600", // startTime - start time (set to future time)
  "1751239200", // endTime - end time (set after startTime)
  "1000000000000000000000", // poolLimitPerUser - user limit 1000 tokens (18 decimals)
  "100000000000000000", // minStakeAmount - minimum stake amount 0.1 token (18 decimals)
  "0", // projectId - project ID
  "0x...", // admin - admin address
];
