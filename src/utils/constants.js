const chainConfigs = {
    'local': {
        nodeUrl: 'ws://localhost:9944',
        pruntimeUrl: 'http://localhost:8000',
        /// my local multisig address: 41MjZJbhdQKaZjEqbsvHXKPyRs1qp8DVU4Pph7XfaMQeqGQ8
        deployerPubkey: '0x20c0c9d3ce492b85c8848effafdbb1a782c589e9b87ff5e3f76a1c7fa41382db',
        isTestnet: true,
    },
    'poc5': {
        nodeUrl: 'wss://poc5.phala.network/ws',
        pruntimeUrl: 'https://poc5.phala.network/tee-api-1',
        /// Alice: 5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY
        deployerPubkey: '0xd43593c715fdd31c61141abd04a99fd6822c8558854ccde39a5684e7a56da27d',
        isTestnet: true,
    },
    'mainnet': {
        nodeUrl: 'wss://api.phala.network/ws',
        pruntimeUrl: 'https://phat-cluster-de.phala.network/pruntime-03',
        /// Phala council address: 411YcLnTpRedPqFjFYLMFbxLMwnhjDXQvzV21gJLbp67T7Y4
        deployerPubkey: '0x115b06fd88601f903a94a70cdcedca7ed6b77fed4e0d4fda0a5511970ab4aa5d',
        isTestnet: false,
    }
};

const PHA = 1_000_000_000_000;
const DEFAULT_TX_CONFIG = { gasLimit: "100000000000" };

module.exports = { chainConfigs, PHA, DEFAULT_TX_CONFIG };
