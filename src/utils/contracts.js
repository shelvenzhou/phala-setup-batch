const fs = require('fs');
const Phala = require('@phala/sdk');
const { ContractPromise } = require('@polkadot/api-contract');
const { blake2AsHex } = require('@polkadot/util-crypto');
const { checkUntil } = require('./common')


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

function loadContractFile(contractFile) {
    const metadata = JSON.parse(fs.readFileSync(contractFile));
    const constructor = metadata.spec.constructors.find(c => c.label == 'default' || c.label == 'new').selector;
    const name = metadata.contract.name;
    const wasm = metadata.source.wasm;
    return { wasm, metadata, constructor, name };
}

async function estimateFee(api, system, certAnyone, contract, salt) {
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
    }, certAnyone);

    // console.log("instantiate result:", instantiateReturn);
    const queryResponse = api.createType('InkResponse', instantiateReturn);
    const queryResult = queryResponse.result.toHuman()
    // console.log("InkMessageReturn", queryResult.Ok.InkMessageReturn);
    // const instantiateResult = api.createType('ContractInstantiateResult', queryResult.Ok.result);
    // console.assert(instantiateResult.result.isOk, 'fee estimation failed');
    console.log(`estimateFee ${JSON.stringify(queryResponse)}`);
    return instantiateReturn;
}

async function uploadCode(api, txqueue, pairAnyone, certAnyone, clusterId, codeType, wasm, system) {
    let hash = blake2AsHex(wasm);
    console.log(`Upload ${codeType} ${hash}`);
    let type = codeType == "SidevmCode" ? 'Sidevm' : 'Ink';
    const { output } = await system.query["system::codeExists"](certAnyone, {}, hash, type);
    if (output.asOk.toPrimitive()) {
        console.log("Code exists")
        return;
    }

    await txqueue.submit(
        api.tx.phalaPhatContracts.clusterUploadResource(clusterId, codeType, wasm),
        pairAnyone
    );
    await checkUntil(async () => {
        const { output } = await system.query["system::codeExists"](certAnyone, {}, hash, type);
        return output.asOk.toPrimitive();
    }, 8 * 3000);
    console.log("Code uploaded")
}

async function systemGetDriver(system, certAnyone, driver) {
    const { output } = await system.query["system::getDriver"](certAnyone, {}, driver);
    console.log(`Find driver ${driver} at ${output.asOk.toHex()}`);
    return output.asOk.toHex();
}

module.exports = {
    contractApi, loadContractFile, estimateFee, uploadCode, systemGetDriver
}
