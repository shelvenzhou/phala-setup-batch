const { ApiPromise, WsProvider, Keyring } = require('@polkadot/api');
const { Abi } = require('@polkadot/api-contract');
const { typeDefinitions } = require('@polkadot/types');
const Phala = require('@phala/sdk');
const crypto = require('crypto');
const { PRuntimeApi } = require('./utils/pruntime');
const { chainConfigs } = require('./utils/constants');
const { TxQueue, systemSetDriverTx } = require('./utils/transactions')
const { contractApi, loadContractFile, estimateFee } = require('./utils/contracts')
const { hex } = require('./utils/common')

async function main() {
    // **CHECK HERE**
    const chainConfig = chainConfigs['mainnet'];
    const clusterId = '0x0000000000000000000000000000000000000000000000000000000000000001';

    const driversDir = './res';
    const contractSystem = loadContractFile(`${driversDir}/system.contract`);
    const contractQjs = loadContractFile(`${driversDir}/qjs.contract`);

    const phatBricksDir = './res/phat-bricks'
    const contractBrickProfileFactory = loadContractFile(`${phatBricksDir}/brick_profile_factory.contract`);

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

    // Deploy BrickProfileFactory
    const abi = new Abi(contractBrickProfileFactory.metadata);
    const callData = abi.findConstructor("new").toU8a(["0xdffe5496e9e48d444cad5d2bc37ce8098e0080e90d871dd5b03ec2a6aada49c5"]);
    let salt = hex(crypto.randomBytes(4));
    let estimatedFee = await estimateFee(api, system, certAnyone, contractBrickProfileFactory, salt);
    const { id: contractId } = await worker.api.calculateContractId({
        deployer: deployerPubkey,
        clusterId,
        codeHash: contractBrickProfileFactory.metadata.source.hash,
        salt,
    });
    console.log(`Instantiate code ${contractBrickProfileFactory.metadata.source.hash}, salt ${salt} to contract ${contractId}`);
    let batchTx = api.tx.utility.batchAll([
        await systemSetDriverTx(system, certAnyone, "JsDelegate", contractQjs),
        await api.tx.phalaPhatContracts.instantiateContract(
            { WasmCode: contractBrickProfileFactory.metadata.source.hash },
            callData,
            salt,
            clusterId,
            0,
            estimatedFee.gasRequired.refTime,
            estimatedFee.storageDeposit.asCharge || 0,
            0
        )
    ]);
    console.log(`Batch tx: ${batchTx.toHex()}`);

    contractBrickProfileFactory.address = "0xb59bcc4ea352f3d878874d8f496fb093bdf362fa59d6e577c075f41cd7c84924";
    const profileFactory = await contractApi(api, pruntimeUrl, contractBrickProfileFactory);
    const profileCodeHash = "0x3b3d35f92494fe60d9f9f6139ea83964dc4bca84d7ac66e985024358c9c62969";
    let tx = await profileFactorySetCodeHash(profileFactory, certAnyone, profileCodeHash);
    console.log(`Tx: ${tx.toHex()}`);

    return;
}

main().then(process.exit).catch(err => console.error('Crashed', err)).finally(() => process.exit(-1));
