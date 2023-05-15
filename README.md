# Phala Blockchain Setup Scripts

that try to batch everything.

## Solution

```js
// anyone can do this
batchAll {
    api.tx.phalaPhatContracts.instantiateContract(TokenomicContract)
    api.tx.phalaPhatContracts.instantiateContract(SidevmDeployer)
}

// Cluster owner only
batchAll {
    api.tx.phalaPhatTokenomic.adjustStake(systemContract, CENTS * stakedCents) // stake for systemContract
    system.tx["system::setDriver"](options, "ContractDeposit", contract.address)
    system.tx["system::setDriver"](options, "SidevmOperation", contract.address)
    sidevmDeployer.tx.allow(defaultTxConfig, loggerId)
    api.tx.phalaPhatContracts.instantiateContract(LoggerServer)
}

// Cluster owner only
system.tx["system::setDriver"](options, "PinkLogger", contract.address)
```
