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
    system.tx["system::setDriver"](options, "ContractDeposit", contractTokenomics.address)
    system.tx["system::setDriver"](options, "SidevmOperation", contractSidevmop.address)
    api.tx.phalaPhatTokenomic.adjustStake(systemContract, CENTS * stakedCents) // stake for systemContract
    sidevmDeployer.tx.allow(defaultTxConfig, loggerId)
    api.tx.phalaPhatContracts.instantiateContract(LoggerServer)
}

// Cluster owner only
batchAll {
    system.tx["system::setDriver"](options, "PinkLogger", contract.address)
}
```
## Checklist

- [ ] it works using `batchAll` with normal account
  - [x] instantiate tokenomics and sidevm_deployer contracts
  - [ ] set drivers and allow logger_server to start sidevm, then instantiate log_server
  - [ ] set log driver
- [ ] it works using `batchAll` with multisig account
  - [x] instantiate tokenomics and sidevm_deployer contracts
  - [ ] set drivers and allow logger_server to start sidevm, then instantiate log_server
  - [ ] set log driver
