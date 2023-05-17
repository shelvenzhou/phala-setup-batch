require('dotenv').config();

const { ApiPromise, WsProvider, Keyring } = require('@polkadot/api');
const { typeDefinitions } = require('@polkadot/types');
const Phala = require('@phala/sdk');
const fs = require('fs');
const { PRuntimeApi } = require('./utils/pruntime');

const BLOCK_INTERVAL = 3_000;

function loadContractFile(contractFile) {
    const metadata = JSON.parse(fs.readFileSync(contractFile));
    const constructor = metadata.spec.constructors.find(c => c.label == 'default').selector;
    const name = metadata.contract.name;
    const wasm = metadata.source.wasm;
    return { wasm, metadata, constructor, name };
}

async function uploadSystemCode(api, txqueue, pair, wasm) {
    console.log(`Uploading system code`);
    await txqueue.submit(
        api.tx.sudo.sudo(api.tx.phalaPhatContracts.setPinkSystemCode(hex(wasm))),
        pair
    );
    await checkUntil(async () => {
        let code = await api.query.phalaPhatContracts.pinkSystemCode();
        return code[1] == wasm;
    }, 8 * BLOCK_INTERVAL);
    console.log(`Uploaded system code`);
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

async function sleep(t) {
    await new Promise(resolve => {
        setTimeout(resolve, t);
    });
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

async function forceRegisterWorker(api, txpool, pair, worker) {
    console.log('Worker: registering', worker);
    await txpool.submit(
        api.tx.sudo.sudo(
            api.tx.phalaRegistry.forceRegisterWorker(worker, worker, null)
        ),
        pair,
    );
    await checkUntil(
        async () => (await api.query.phalaRegistry.workers(worker)).isSome,
        8 * BLOCK_INTERVAL
    );
    console.log('Worker: added');
}

async function setupGatekeeper(api, txpool, pair, worker) {
    const gatekeepers = await api.query.phalaRegistry.gatekeeper();
    if (gatekeepers.toHuman().includes(worker)) {
        console.log('Gatekeeper: skip', worker);
        return;
    }
    console.log('Gatekeeper: registering');
    await txpool.submit(
        api.tx.sudo.sudo(
            api.tx.phalaRegistry.registerGatekeeper(worker)
        ),
        pair,
    );
    await checkUntil(
        async () => (await api.query.phalaRegistry.gatekeeper()).toHuman().includes(worker),
        8 * BLOCK_INTERVAL
    );
    console.log('Gatekeeper: added');
    await checkUntil(
        async () => (await api.query.phalaRegistry.gatekeeperMasterPubkey()).isSome,
        8 * BLOCK_INTERVAL
    );
    console.log('Gatekeeper: master key ready');
}

async function deployCluster(api, txqueue, sudoer, owner, workers, treasury, defaultCluster = '0x0000000000000000000000000000000000000000000000000000000000000001') {
    const clusterInfo = await api.query.phalaPhatContracts.clusters(defaultCluster);
    if (clusterInfo.isSome) {
        return { clusterId: defaultCluster, systemContract: clusterInfo.unwrap().systemContract.toHex() };
    }
    console.log('Cluster: creating');
    // crete contract cluster and wait for the setup
    const { events } = await txqueue.submit(
        api.tx.sudo.sudo(api.tx.phalaPhatContracts.addCluster(
            owner,
            'Public', // can be {'OnlyOwner': accountId}
            workers,
            "10000000000000000", // 10000 PHA
            1, 1, 1, treasury.address
        )),
        sudoer
    );
    const ev = events[1].event;
    console.assert(ev.section == 'phalaPhatContracts' && ev.method == 'ClusterCreated');
    const clusterId = ev.data[0].toString();
    const systemContract = ev.data[1].toString();
    console.log('Cluster: created on chain', clusterId);

    console.log('Cluster: wait for GK key generation');
    await checkUntil(
        async () => (await api.query.phalaRegistry.clusterKeys(clusterId)).isSome,
        8 * BLOCK_INTERVAL
    );

    console.log('Cluster: wait for system contract instantiation');
    await checkUntil(
        async () => (await api.query.phalaRegistry.contractKeys(systemContract)).isSome,
        8 * BLOCK_INTERVAL
    );
    return { clusterId, systemContract };
}

function loadUrls(exp, defaultVal) {
    if (!exp) {
        return defaultVal
    }
    return exp.trim().split(',');
}

async function main() {
    const nodeUrl = process.env.ENDPOINT || 'wss://poc5.phala.network/ws';
    const workerUrls = loadUrls(process.env.WORKERS, ['https://poc5.phala.network/tee-api-1']);
    const gatekeeperUrls = loadUrls(process.env.GKS, ['https://poc5.phala.network/gk-api']);

    const sudoAccount = process.env.SUDO || '//Alice';
    const treasuryAccount = process.env.TREASURY || '//Treasury';
    const driversDir = process.env.DRIVERS_DIR || './res';

    const contractSystem = loadContractFile(`${driversDir}/system.contract`);

    // Connect to the chain
    const wsProvider = new WsProvider(nodeUrl);
    const api = await ApiPromise.create({
        provider: wsProvider,
        types: {
            ...Phala.types,
            'GistQuote': {
                username: 'String',
                accountId: 'AccountId',
            },
            ...typeDefinitions.contracts.types,
        }
    });
    const txqueue = new TxQueue(api);

    // Prepare accounts
    const keyring = new Keyring({ type: 'sr25519' });
    const sudo = keyring.addFromUri(sudoAccount);
    const treasury = keyring.addFromUri(treasuryAccount);

    // Connect to pruntimes
    const workers = await Promise.all(workerUrls.map(async w => {
        let api = new PRuntimeApi(w);
        let pubkey = hex((await api.getInfo()).publicKey);
        return {
            url: w,
            pubkey: pubkey,
            api: api,
        };
    }));
    const gatekeepers = await Promise.all(gatekeeperUrls.map(async w => {
        let api = new PRuntimeApi(w);
        let pubkey = hex((await api.getInfo()).publicKey);
        return {
            url: w,
            pubkey: pubkey,
            api: api,
        };
    }));
    console.log('Workers:', workers);
    console.log('Gatekeepers', gatekeepers);

    // Basic phala network setup
    for (const w of workers) {
        await forceRegisterWorker(api, txqueue, sudo, w.pubkey);
        await w.api.addEndpoint({ encodedEndpointType: [1], endpoint: w.url }); // EndpointType: 0 for I2P and 1 for HTTP
    }
    for (const w of gatekeepers) {
        await forceRegisterWorker(api, txqueue, sudo, w.pubkey);
        await setupGatekeeper(api, txqueue, sudo, w.pubkey);
    }

    // Upload the pink-system wasm to the chain. It is required to create a cluster.
    await uploadSystemCode(api, txqueue, sudo, contractSystem.wasm);

    const { clusterId, systemContract } = await deployCluster(api, txqueue, sudo, sudo.address, workers.map(w => w.pubkey), treasury);
    contractSystem.address = systemContract;
    console.log('Cluster system contract address:', systemContract);
}

main().then(process.exit).catch(err => console.error('Crashed', err)).finally(() => process.exit(-1));
