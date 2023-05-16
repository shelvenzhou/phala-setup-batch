# Phala Blockchain Setup Scripts

that try to batch everything.

## Solution

```js
// Anyone
// 0. register GK
// 1. create cluster
// 2. transfer to cluster
// 3. upload all contracts

// Cluster owner only (since SidevmDeployer records its owner)
batchAll {
    api.tx.phalaPhatContracts.instantiateContract(contractTokenomics)
    api.tx.phalaPhatContracts.instantiateContract(contractSidevmop)
}

// Cluster owner only
batchAll {
    api.tx.phalaPhatTokenomic.adjustStake(systemContract, CENTS * stakedCents) // stake for systemContract
    system.tx["system::setDriver"](options, "ContractDeposit", contractTokenomics.address)
    system.tx["system::setDriver"](options, "SidevmOperation", contractSidevmop.address)
    sidevmDeployer.tx.allow(defaultTxConfig, loggerId)
    api.tx.phalaPhatContracts.instantiateContract(LoggerServer)
}

// Cluster owner only
system.tx["system::setDriver"](options, "PinkLogger", contract.address)
```
