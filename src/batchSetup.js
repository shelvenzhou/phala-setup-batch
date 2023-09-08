const { ApiPromise, WsProvider, Keyring } = require('@polkadot/api');
const { typeDefinitions } = require('@polkadot/types');
const Phala = require('@phala/sdk');
const fs = require('fs');
const crypto = require('crypto');
const { PRuntimeApi } = require('./utils/pruntime');
const { chainConfigs, PHA, DEFAULT_TX_CONFIG } = require('./utils/constants');
const { TxQueue, systemSetDriverTx, systemGrantAdminTx, instantiateContractTx, stopLogServerTx } = require('./utils/transactions')
const { contractApi, loadContractFile, uploadCode, systemGetDriver } = require('./utils/contracts')
const { hex, checkUntil } = require('./utils/common')

async function main() {
    // **CHECK HERE**
    const chainConfig = chainConfigs['mainnet'];
    const clusterId = '0x0000000000000000000000000000000000000000000000000000000000000001';

    const driversDir = './res';
    const contractSystem = loadContractFile(`${driversDir}/system.contract`);
    const contractSidevmop = loadContractFile(`${driversDir}/sidevm_deployer.contract`);
    const contractLogServer = loadContractFile(`${driversDir}/log_server.contract`);
    const contractOldLogServer = loadContractFile(`${driversDir}/log_server.contract`);
    const contractTokenomic = loadContractFile(`${driversDir}/tokenomic.contract`);
    // const contractQjs = loadContractFile(`${driversDir}/qjs.contract`);
    const logServerSidevmWasm = fs.readFileSync(`${driversDir}/log_server.sidevm.wasm`, 'hex');
    const contractTagBag = loadContractFile(`${driversDir}/tagbag.contract`);

    // Connect to node
    const wsProvider = new WsProvider(chainConfig.nodeUrl)
    const api = await ApiPromise.create({
        provider: wsProvider,
        types: {
            ...Phala.types,
            ...typeDefinitions.contracts.types,
        },
        noInitWarn: true
    })
    const txqueue = new TxQueue(api);

    // Connect to pRuntime
    let pruntimeUrl = chainConfig.pruntimeUrl;
    let pRuntimeApi = new PRuntimeApi(pruntimeUrl);
    let workerPubkey = hex((await pRuntimeApi.getInfo()).publicKey);
    const worker = {
        url: pruntimeUrl,
        pubkey: workerPubkey,
        api: pRuntimeApi,
    }

    const keyring = new Keyring({ type: 'sr25519' });
    const pairAnyone = keyring.addFromUri('//Alice');
    const certAnyone = await Phala.signCertificate({ api, pair: pairAnyone });

    const clusterInfo = await api.query.phalaPhatContracts.clusters(clusterId);
    const systemContract = clusterInfo.unwrap().systemContract.toHex();
    contractSystem.address = systemContract;

    const system = await contractApi(api, pruntimeUrl, contractSystem);

    // tokens for code uploading
    if (chainConfig.isTestnet) {
        await txqueue.submit(api.tx.phalaPhatContracts.transferToCluster(1000 * PHA, clusterId, hex(pairAnyone.publicKey)), pairAnyone);
        await checkUntil(async () => {
            const { output } = await system.query["system::totalBalanceOf"](certAnyone, {}, hex(pairAnyone.publicKey));
            return output.asOk.toPrimitive() > 0;
        }, 8 * 3000);
    }

    console.log(`Upload ${contractTokenomic.name}`)
    await uploadCode(api, txqueue, pairAnyone, certAnyone, clusterId, "InkCode", contractTokenomic.wasm, system);
    console.log(`Upload ${contractSidevmop.name}`)
    await uploadCode(api, txqueue, pairAnyone, certAnyone, clusterId, "InkCode", contractSidevmop.wasm, system);
    console.log(`Upload ${contractLogServer.name}`)
    await uploadCode(api, txqueue, pairAnyone, certAnyone, clusterId, "InkCode", contractLogServer.wasm, system);
    console.log(`Upload log_server.sidevm`)
    await uploadCode(api, txqueue, pairAnyone, certAnyone, clusterId, "SidevmCode", hex(logServerSidevmWasm), system);
    console.log(`Upload ${contractTagBag.name}`)
    await uploadCode(api, txqueue, pairAnyone, certAnyone, clusterId, "InkCode", contractTagBag.wasm, system);

    let deployerPubkey = chainConfig.deployerPubkey;
    // TX1: Batch setup contractTokenomic and contractSidevmop
    let batchSetupTx = api.tx.utility.batchAll([
        api.tx.phalaPhatTokenomic.adjustStake(systemContract, 50 * PHA), // stake for systemContract
        await instantiateContractTx(api, worker, system, deployerPubkey, certAnyone, clusterId, contractTokenomic),
        await instantiateContractTx(api, worker, system, deployerPubkey, certAnyone, clusterId, contractSidevmop),
        await systemSetDriverTx(system, certAnyone, "ContractDeposit", contractTokenomic),
        await systemGrantAdminTx(system, certAnyone, contractTokenomic),
        await systemSetDriverTx(system, certAnyone, "SidevmOperation", contractSidevmop),
        await systemGrantAdminTx(system, certAnyone, contractSidevmop),

    ]);
    console.log(`Batch setup tx: ${batchSetupTx.toHex()}`);

    // TX2: Batch setup logger
    contractSidevmop.address = await systemGetDriver(system, certAnyone, "SidevmOperation");
    const sidevmDeployer = await contractApi(api, pruntimeUrl, contractSidevmop);

    let loggerSalt = hex(crypto.randomBytes(4));
    const { id: loggerId } = await worker.api.calculateContractId({
        deployer: deployerPubkey,
        clusterId,
        codeHash: contractLogServer.metadata.source.hash,
        salt: loggerSalt,
    });
    console.log(`calculated loggerId = ${loggerId}`);
    contractLogServer.address = loggerId;

    contractOldLogServer.address = await systemGetDriver(system, certAnyone, "PinkLogger");
    const oldLogServer = await contractApi(api, pruntimeUrl, contractOldLogServer);

    let batchLoggerTx = api.tx.utility.batchAll([
        await stopLogServerTx(oldLogServer, certAnyone),
        await systemSetDriverTx(system, certAnyone, "PinkLogger", contractLogServer),
        await systemGrantAdminTx(system, certAnyone, contractLogServer),
        // sidevmDeployer.tx.allow(DEFAULT_TX_CONFIG, loggerId),
        // await instantiateContractTx(api, worker, system, deployerPubkey, certAnyone, clusterId, contractLogServer, loggerSalt)
        await instantiateContractTx(api, worker, system, deployerPubkey, certAnyone, clusterId, contractTagBag),
        await systemSetDriverTx(system, certAnyone, "TagStack", contractTagBag),
        await systemGrantAdminTx(system, certAnyone, contractTagBag),

    ]);
    console.log(`Batch init logger tx: ${batchLoggerTx.toHex()}`);
}

main().then(process.exit).catch(err => console.error('Crashed', err)).finally(() => process.exit(-1));
