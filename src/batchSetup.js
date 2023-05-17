const { ApiPromise, WsProvider, Keyring } = require('@polkadot/api');
const { typeDefinitions } = require('@polkadot/types');
const { ContractPromise } = require('@polkadot/api-contract');
const { blake2AsHex } = require('@polkadot/util-crypto');
const Phala = require('@phala/sdk');
const fs = require('fs');
const crypto = require('crypto');
const { PRuntimeApi } = require('./utils/pruntime');

const PHA = 1_000_000_000_000;
const DEFAULT_TX_CONFIG = { gasLimit: "100000000000" };

function hex(b) {
    if (typeof b != "string") {
        b = Buffer.from(b).toString('hex');
    }
    if (!b.startsWith('0x')) {
        return '0x' + b;
    } else {
        return b;
    }
}

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

async function checkUntil(async_fn, timeout) {
    const t0 = new Date().getTime();
    while (true) {
        if (await async_fn()) {
            return;
        }
        const t = new Date().getTime();
        if (t - t0 >= timeout) {
            throw new Error('timeout');
        }
        await sleep(100);
    }
}

function loadContractFile(contractFile) {
    const metadata = JSON.parse(fs.readFileSync(contractFile));
    const constructor = metadata.spec.constructors.find(c => c.label == 'default').selector;
    const name = metadata.contract.name;
    const wasm = metadata.source.wasm;
    return { wasm, metadata, constructor, name };
}

async function estimateFee(api, system, cert, contract, salt) {
    // Estimate gas limit
    /*
        InkInstantiate {
            code_hash: sp_core::H256,
            salt: Vec<u8>,
            instantiate_data: Vec<u8>,
            /// Amount of tokens deposit to the caller.
            deposit: u128,
            /// Amount of tokens transfer from the caller to the target contract.
            transfer: u128,
        },
     */
    const instantiateReturn = await system.instantiate({
        codeHash: contract.metadata.source.hash,
        salt,
        instantiateData: contract.constructor, // please concat with args if needed
        deposit: 0,
        transfer: 0,
        estimating: true
    }, cert);

    // console.log("instantiate result:", instantiateReturn);
    const queryResponse = api.createType('InkResponse', instantiateReturn);
    const queryResult = queryResponse.result.toHuman()
    // console.log("InkMessageReturn", queryResult.Ok.InkMessageReturn);
    // const instantiateResult = api.createType('ContractInstantiateResult', queryResult.Ok.result);
    // console.assert(instantiateResult.result.isOk, 'fee estimation failed');
    console.log(`estimateFee ${JSON.stringify(queryResponse)}`);
    return instantiateReturn;
}

async function uploadCode(api, txqueue, pair, cert, clusterId, codeType, wasm, system) {
    let hash = blake2AsHex(wasm);
    console.log(`Upload ${codeType} ${hash}`);
    let type = codeType == "SidevmCode" ? 'Sidevm' : 'Ink';
    const { output } = await system.query["system::codeExists"](cert, {}, hash, type);
    if (output.asOk.toPrimitive()) {
        console.log("Code exists")
        return;
    }

    await txqueue.submit(
        api.tx.phalaPhatContracts.clusterUploadResource(clusterId, codeType, wasm),
        pair
    );
    await checkUntil(async () => {
        const { output } = await system.query["system::codeExists"](cert, {}, hash, type);
        return output.asOk;
    }, 8 * 3000);
    console.log("Code uploaded")
}

async function instantiateContractTx(api, worker, system, pair, cert, clusterId, contract, salt) {
    salt = salt ? salt : hex(crypto.randomBytes(4));

    const { id: contractId } = await worker.api.calculateContractId({
        deployer: hex(pair.publicKey),
        clusterId,
        codeHash: contract.metadata.source.hash,
        salt,
    });
    contract.address = contractId;

    console.log(`Instantiate code ${contract.metadata.source.hash}, input ${contract.constructor}, salt ${salt} to contract ${contractId}`);
    let estimatedFee = await estimateFee(api, system, cert, contract, salt);
    return api.tx.phalaPhatContracts.instantiateContract(
        { WasmCode: contract.metadata.source.hash },
        contract.constructor,
        salt,
        clusterId,
        0,
        estimatedFee.gasRequired.refTime,
        estimatedFee.storageDeposit.asCharge || 0,
        0
    );
}

async function systemSetDriverTx(system, cert, driverName, contract) {
    const { gasRequired, storageDeposit } = await system.query["system::setDriver"](cert, {}, driverName, contract.address);
    let options = {
        value: 0,
        gasLimit: gasRequired,
        storageDepositLimit: storageDeposit.isCharge ? storageDeposit.asCharge : null
    };

    return system.tx["system::setDriver"](options, driverName, contract.address);
}

async function systemGrantAdminTx(system, cert, contract) {
    const { gasRequired, storageDeposit } = await system.query["system::grantAdmin"](cert, {}, contract.address);
    let options = {
        value: 0,
        gasLimit: gasRequired,
        storageDepositLimit: storageDeposit.isCharge ? storageDeposit.asCharge : null
    };

    return system.tx["system::grantAdmin"](options, contract.address);
}

async function contractApi(api, pruntimeUrl, contract) {
    const newApi = await api.clone().isReady;
    const phala = await Phala.create({ api: newApi, baseURL: pruntimeUrl, contractId: contract.address, autoDeposit: true });
    const contractApi = new ContractPromise(
        phala.api,
        contract.metadata,
        contract.address,
    );
    contractApi.sidevmQuery = phala.sidevmQuery;
    contractApi.instantiate = phala.instantiate;
    return contractApi;
}

async function main() {
    // **CHECK THESE**
    const nodeUrl = 'ws://localhost:9944';
    const pruntimeUrl = 'http://localhost:8000';
    // const nodeUrl = 'wss://phala.api.onfinality.io/public-ws';
    // const pruntimeUrl = 'https://phat-cluster-de.phala.network/pruntime-01';

    const clusterId = '0x0000000000000000000000000000000000000000000000000000000000000001';

    const driversDir = './res';
    const contractSystem = loadContractFile(`${driversDir}/system.contract`);
    const contractSidevmop = loadContractFile(`${driversDir}/sidevm_deployer.contract`);
    const contractLogServer = loadContractFile(`${driversDir}/log_server.contract`);
    const contractTokenomic = loadContractFile(`${driversDir}/tokenomic.contract`);
    // const contractQjs = loadContractFile(`${driversDir}/qjs.contract`);
    const logServerSidevmWasm = fs.readFileSync(`${driversDir}/log_server.sidevm.wasm`, 'hex');

    // Connect to node
    const wsProvider = new WsProvider(nodeUrl)
    const api = await ApiPromise.create({
        provider: wsProvider, types: {
            ...Phala.types,
            ...typeDefinitions.contracts.types,
        }
    })
    const txqueue = new TxQueue(api);

    // Connect to pRuntime
    let pRuntimeApi = new PRuntimeApi(pruntimeUrl);
    let workerPubkey = hex((await pRuntimeApi.getInfo()).publicKey);
    const worker = {
        url: pruntimeUrl,
        pubkey: workerPubkey,
        api: pRuntimeApi,
    }

    const keyring = new Keyring({ type: 'sr25519' });
    const pairDeployer = keyring.addFromUri('//Alice');
    const certDeployer = await Phala.signCertificate({ api, pair: pairDeployer });

    const clusterInfo = await api.query.phalaPhatContracts.clusters(clusterId);
    const systemContract = clusterInfo.unwrap().systemContract.toHex();
    contractSystem.address = systemContract;

    const system = await contractApi(api, pruntimeUrl, contractSystem);

    console.log(`Upload ${contractTokenomic.name}`)
    await uploadCode(api, txqueue, pairDeployer, certDeployer, clusterId, "InkCode", contractTokenomic.wasm, system);
    console.log(`Upload ${contractSidevmop.name}`)
    await uploadCode(api, txqueue, pairDeployer, certDeployer, clusterId, "InkCode", contractSidevmop.wasm, system);
    console.log(`Upload ${contractLogServer.name}`)
    await uploadCode(api, txqueue, pairDeployer, certDeployer, clusterId, "InkCode", contractLogServer.wasm, system);
    console.log(`Upload log_server.sidevm`)
    await uploadCode(api, txqueue, pairDeployer, certDeployer, clusterId, "SidevmCode", hex(logServerSidevmWasm), system);

    // TX1: Batch setup contractTokenomic and contractSidevmop
    let batchSetupTx = api.tx.utility.batchAll([
        api.tx.phalaPhatTokenomic.adjustStake(systemContract, 50 * PHA), // stake for systemContract
        await instantiateContractTx(api, worker, system, pairDeployer, certDeployer, clusterId, contractTokenomic),
        await instantiateContractTx(api, worker, system, pairDeployer, certDeployer, clusterId, contractSidevmop),
        await systemSetDriverTx(system, certDeployer, "ContractDeposit", contractTokenomic),
        await systemGrantAdminTx(system, certDeployer, contractTokenomic),
        await systemSetDriverTx(system, certDeployer, "SidevmOperation", contractSidevmop),
        await systemGrantAdminTx(system, certDeployer, contractSidevmop),

    ]);
    console.log(`Batch setup tx: ${batchSetupTx.toHex()}`);

    // TX2: Batch setup logger
    // **CHECK THESE**
    contractSidevmop.address = '0x90a1deab503ea628cd2084ccfe53a1c499979ff9e970cd47112bc64a2a0ea223';
    const sidevmDeployer = await contractApi(api, pruntimeUrl, contractSidevmop);

    let loggerSalt = hex(crypto.randomBytes(4));
    const { id: loggerId } = await worker.api.calculateContractId({
        deployer: hex(pairDeployer.publicKey),
        clusterId,
        codeHash: contractLogServer.metadata.source.hash,
        salt: loggerSalt,
    });
    console.log(`calculated loggerId = ${loggerId}`);
    contractLogServer.address = loggerId;

    let batchLoggerTx = api.tx.utility.batchAll([
        await systemSetDriverTx(system, certDeployer, "PinkLogger", contractLogServer),
        await systemGrantAdminTx(system, certDeployer, contractLogServer),
        sidevmDeployer.tx.allow(DEFAULT_TX_CONFIG, loggerId),
        await instantiateContractTx(api, worker, system, pairDeployer, certDeployer, clusterId, contractLogServer, loggerSalt)
    ]);
    console.log(`Batch init logger tx: ${batchLoggerTx.toHex()}`);
}

main().then(process.exit).catch(err => console.error('Crashed', err)).finally(() => process.exit(-1));
