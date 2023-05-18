# Phala Blockchain Setup Scripts

that try to batch everything.

## Attention

1. Ensure your accounts have enough tokens and cluster balance;
2. Ensure the `deployerPubkey` matches the account who instantiates the contracts, otherwise the calculated contract ids are wrong, and you will register wrong driver contracts;
3. The estimated gas fee can be wrong if the test account does not have tokens on real mainnet, increase the value to ensure successful deployment.

## Solution

```js
// Anyone
// 0. register GK
// 1. create cluster
// 2. transfer to cluster, both accounts who upload the code or instantiate the contracts are needed
// 3. upload all contracts

// Cluster owner only
batchAll {
    api.tx.phalaPhatTokenomic.adjustStake(systemContract, CENTS * stakedCents) // stake for systemContract
    api.tx.phalaPhatContracts.instantiateContract(contractTokenomics)
    api.tx.phalaPhatContracts.instantiateContract(contractSidevmop)
    system.tx["system::setDriver"](options, "ContractDeposit", contractTokenomics.address)
    system.tx["system::grantAdmin"](options, contractTokenomics.address)
    system.tx["system::setDriver"](options, "SidevmOperation", contractSidevmop.address)
    system.tx["system::grantAdmin"](options, contractSidevmop.address)
}

// Cluster owner only
batchAll {
    system.tx["system::setDriver"](options, "PinkLogger", contractLogger.address)
    system.tx["system::grantAdmin"](options, contractLogger.address)
    sidevmDeployer.tx.allow(defaultTxConfig, loggerId)
    api.tx.phalaPhatContracts.instantiateContract(LoggerServer)
}
```

## Restrictions

1. The contracts are not necessarily instantiated when you call `system::setDriver` or `system::grantAdmin`;
2. The `sidevmDeployer::allow` must be called when the contractSidevmop is instantiated, that's why we have two batch transactions;
3. You can only instantiate contractLogger after `sidevmDeployer::allow` call, since it starts sidevm in its constructor.

## Checklist

- [x] it works using `batchAll` with normal account
  - [x] setup tokenomics and sidevm_deployer contracts
  - [x] setup log driver
- [x] it works using `batchAll` with multisig account
  - [x] setup tokenomics and sidevm_deployer contracts
  - [x] setup log driver
