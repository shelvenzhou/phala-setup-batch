const { ApiPromise, WsProvider, Keyring } = require('@polkadot/api');
const { typeDefinitions } = require('@polkadot/types');
const { ContractPromise } = require('@polkadot/api-contract');
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
    return instantiateReturn;
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
    // CHECK THESE
    const nodeUrl = 'ws://localhost:9944';
    const pruntimeUrl = 'http://localhost:8000';
    const clusterId = '0x0000000000000000000000000000000000000000000000000000000000000001';

    const driversDir = './res';
    const contractSystem = loadContractFile(`${driversDir}/system.contract`);
    const contractSidevmop = loadContractFile(`${driversDir}/sidevm_deployer.contract`);
    const contractLogServer = loadContractFile(`${driversDir}/log_server.contract`);
    const contractTokenomic = loadContractFile(`${driversDir}/tokenomic.contract`);
    // const contractQjs = loadContractFile(`${driversDir}/qjs.contract`);
    const logServerSidevmWasm = fs.readFileSync(`${driversDir}/log_server.sidevm.wasm`, 'hex');

    // FILL IN THESE
    contractTokenomic.address = '0x3de21ab9ff611916ffc74e2f221973f90224eb2e2089de27ab7990657158b921';
    contractSidevmop.address = '0xd16326fb9fce7ae441393cb4d68a5a0a7d4407b3536acb208799519baab784b6';

    // Connect to pRuntime
    let pRuntimeApi = new PRuntimeApi(pruntimeUrl);
    let workerPubkey = hex((await pRuntimeApi.getInfo()).publicKey);
    const worker = {
        url: pruntimeUrl,
        pubkey: workerPubkey,
        api: pRuntimeApi,
    }

    // Connect to node
    const wsProvider = new WsProvider(nodeUrl)
    const api = await ApiPromise.create({
        provider: wsProvider, types: {
            ...Phala.types,
            ...typeDefinitions.contracts.types,
        }
    })

    const keyring = new Keyring({ type: 'sr25519' });
    const deployer = keyring.addFromUri('//Alice');
    const certDeployer = await Phala.signCertificate({ api, pair: deployer });

    const clusterInfo = await api.query.phalaPhatContracts.clusters(clusterId);
    const systemContract = clusterInfo.unwrap().systemContract.toHex();
    contractSystem.address = systemContract;

    const system = await contractApi(api, pruntimeUrl, contractSystem);
    const sidevmDeployer = await contractApi(api, pruntimeUrl, contractSidevmop);

    // Estimate gas
    let tokenomicOptions;
    {
        const { gasRequired, storageDeposit } = await system.query["system::setDriver"](certDeployer, {}, 'ContractDeposit', contractTokenomic.address);
        tokenomicOptions = {
            value: 0,
            gasLimit: gasRequired,
            storageDepositLimit: storageDeposit.isCharge ? storageDeposit.asCharge : null
        };
    }
    let sidevmopOptions;
    {
        const { gasRequired, storageDeposit } = await system.query["system::setDriver"](certDeployer, {}, 'SidevmOperation', contractSidevmop.address);
        sidevmopOptions = {
            value: 0,
            gasLimit: gasRequired,
            storageDepositLimit: storageDeposit.isCharge ? storageDeposit.asCharge : null
        };
    }

    // Allow the logger to deploy sidevm
    let salt = hex(crypto.randomBytes(4));
    const { id: loggerId } = await worker.api.calculateContractId({
        deployer: hex(deployer.publicKey),
        clusterId,
        codeHash: contractLogServer.metadata.source.hash,
        salt,
    });
    console.log(`calculated loggerId = ${loggerId}`);
    let estimatedFee = await estimateFee(api, system, certDeployer, contractLogServer, salt);

    const tx = api.tx.utility.batchAll([
        api.tx.phalaPhatTokenomic.adjustStake(systemContract, 100 * PHA), // stake for systemContract
        system.tx["system::setDriver"](tokenomicOptions, "ContractDeposit", contractTokenomic.address),
        system.tx["system::setDriver"](sidevmopOptions, "SidevmOperation", contractSidevmop.address),
        sidevmDeployer.tx.allow(DEFAULT_TX_CONFIG, loggerId),
        api.tx.phalaPhatContracts.instantiateContract(
            { WasmCode: contractLogServer.metadata.source.hash },
            contractLogServer.constructor,
            salt,
            clusterId,
            0,
            estimatedFee.gasRequired.refTime,
            estimatedFee.storageDeposit.asCharge || 0,
            0
        ),
    ]);

    // eslint-disable-next-line no-console
    console.log(tx.toHex())
}

main().then(process.exit).catch(err => console.error('Crashed', err)).finally(() => process.exit(-1));
