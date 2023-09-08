const crypto = require('crypto');
const { estimateFee } = require('./contracts')
const { hex } = require('./common')
const { PHA } = require('./constants')

class TxQueue {
    constructor(api) {
        this.nonceTracker = {};
        this.api = api;
    }
    async nextNonce(address) {
        const byCache = this.nonceTracker[address] || 0;
        const byRpc = (await this.api.rpc.system.accountNextIndex(address)).toNumber();
        return Math.max(byCache, byRpc);
    }
    markNonceFailed(address, nonce) {
        if (!this.nonceTracker[address]) {
            return;
        }
        if (nonce < this.nonceTracker[address]) {
            this.nonceTracker[address] = nonce;
        }
    }
    async submit(txBuilder, signer, waitForFinalization = false) {
        const address = signer.address;
        const nonce = await this.nextNonce(address);
        this.nonceTracker[address] = nonce + 1;
        let hash;
        return new Promise(async (resolve, reject) => {
            const unsub = await txBuilder.signAndSend(signer, { nonce }, (result) => {
                if (result.status.isInBlock) {
                    for (const e of result.events) {
                        const { event: { data, method, section } } = e;
                        if (section === 'system' && method === 'ExtrinsicFailed') {
                            unsub();
                            reject(data[0].toHuman())
                        }
                    }
                    if (!waitForFinalization) {
                        unsub();
                        resolve({
                            hash: result.status.asInBlock,
                            events: result.events,
                        });
                    } else {
                        hash = result.status.asInBlock;
                    }
                } else if (result.status.isFinalized) {
                    resolve({
                        hash,
                        events: result.events,
                    })
                } else if (result.status.isInvalid) {
                    unsub();
                    this.markNonceFailed(address, nonce);
                    reject('Invalid transaction');
                }
            });
        });
    }
}

async function instantiateContractTx(api, worker, system, deployerPubkey, certAnyone, clusterId, contract, salt) {
    salt = salt ? salt : hex(crypto.randomBytes(4));

    const { id: contractId } = await worker.api.calculateContractId({
        deployer: deployerPubkey,
        clusterId,
        codeHash: contract.metadata.source.hash,
        salt,
    });
    contract.address = contractId;

    console.log(`Instantiate code ${contract.metadata.source.hash}, input ${contract.constructor}, salt ${salt} to contract ${contractId}`);
    let estimatedFee = await estimateFee(api, system, certAnyone, contract, salt);
    return api.tx.phalaPhatContracts.instantiateContract(
        { WasmCode: contract.metadata.source.hash },
        contract.constructor,
        salt,
        clusterId,
        0,
        estimatedFee.gasRequired.refTime * 10,
        estimatedFee.storageDeposit.asCharge || 0,
        0
    );
}

async function transferToClusterTx(api, phaToken, clusterId, toAccount) {
    return api.tx.phalaPhatContracts.transferToCluster(phaToken * PHA, clusterId, hex(toAccount));
}

async function adjustStakeTx(api, phaToken, toContract) {
    return api.tx.phalaPhatTokenomic.adjustStake(toContract, phaToken * PHA);
}

async function systemSetDriverTx(system, certAnyone, driverName, contract) {
    const { gasRequired, storageDeposit } = await system.query["system::setDriver"](certAnyone, {}, driverName, contract.address);
    let options = {
        value: 0,
        gasLimit: gasRequired.refTime * 10,
        storageDepositLimit: storageDeposit.isCharge ? storageDeposit.asCharge : null
    };

    return system.tx["system::setDriver"](options, driverName, contract.address);
}

async function systemGrantAdminTx(system, certAnyone, contract) {
    const { gasRequired, storageDeposit } = await system.query["system::grantAdmin"](certAnyone, {}, contract.address);
    let options = {
        value: 0,
        gasLimit: gasRequired.refTime * 10,
        storageDepositLimit: storageDeposit.isCharge ? storageDeposit.asCharge : null
    };

    return system.tx["system::grantAdmin"](options, contract.address);
}

async function stopLogServerTx(logServer, certAnyone) {
    const { gasRequired, storageDeposit } = await logServer.query["stop"](certAnyone, {});
    let options = {
        value: 0,
        gasLimit: gasRequired.refTime * 10,
        storageDepositLimit: storageDeposit.isCharge ? storageDeposit.asCharge : null
    };

    return logServer.tx["stop"](options);
}

module.exports = {
    TxQueue, instantiateContractTx, transferToClusterTx, adjustStakeTx,
    systemSetDriverTx, systemGrantAdminTx, stopLogServerTx
}
