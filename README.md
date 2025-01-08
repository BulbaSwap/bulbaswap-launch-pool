# BulbaSwapLaunchPool

A decentralized staking and reward distribution platform built on Ethereum. This project allows users to stake tokens and earn rewards over time.

## Architecture

The project consists of three main contracts:

1. **LaunchPool**: The core staking contract that handles:

   - Token staking and withdrawal
   - Reward distribution
   - User limit management
   - Emergency functions

2. **LaunchPoolFactory**: A factory contract that:

   - Deploys new LaunchPool instances
   - Ensures proper initialization of pools
   - Manages deployment permissions

3. **MockToken**: A standard ERC20 token used for testing:
   - Basic ERC20 functionality
   - Minting capability (owner only)
   - Used for both staking and rewards

## Features

- Multiple independent staking pools
- Configurable staking and reward tokens
- Time-based reward distribution
- User staking limits
- Emergency withdrawal functions
- Admin controls for pool management
- Gas-efficient implementation

## Getting Started

### Prerequisites

- Node.js v14+
- Yarn
- Hardhat

### Installation

```bash
# Install dependencies
yarn install
```

### Testing

```bash
# Run all tests
yarn hardhat test

# Run tests with gas reporting
REPORT_GAS=true yarn hardhat test
```

## Usage

### Deploying a New Pool

1. Deploy the LaunchPoolFactory:

```typescript
const LaunchPoolFactory = await ethers.getContractFactory("LaunchPoolFactory");
const factory = await LaunchPoolFactory.deploy();
await factory.waitForDeployment();
```

2. Deploy a new LaunchPool through the factory:

```typescript
const poolAddress = await factory.deployPool(
  stakedToken, // The token users will stake
  rewardToken, // The token users will earn
  rewardPerSecond, // Reward rate per second
  startTime, // Pool start time
  endTime, // Pool end time
  poolLimitPerUser, // Maximum stake per user (0 for no limit)
  admin // Pool admin address
);
```

### Interacting with a Pool

1. Stake tokens:

```typescript
await stakedToken.approve(poolAddress, amount);
await launchPool.deposit(amount);
```

2. Withdraw tokens:

```typescript
await launchPool.withdraw(amount);
```

3. Claim rewards (after pool ends):

```typescript
await launchPool.claimReward();
```

## Gas Optimization

The contracts are optimized for gas efficiency:

- LaunchPool deployment: ~1.9M gas
- Token deposit: ~110K gas
- Token withdrawal: ~115K gas
- Reward claim: ~125K gas

## Security

Key security features:

- Reentrancy protection
- Owner access control
- Emergency withdrawal functions
- Token recovery for wrong transfers
- Input validation

## License

MIT
