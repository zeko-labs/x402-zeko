import 'reflect-metadata';
import { fetchAccount, Mina, PublicKey } from 'o1js';
import { X402SettlementContract } from '../contracts/X402SettlementContract.js';
import { assertActiveZekoEndpoint, readOptionalEnv, requireEnv } from './utils.js';
function isFetchAccountNotFound(error) {
    if (!error || typeof error !== 'object')
        return false;
    const statusCode = 'statusCode' in error ? Number(error.statusCode) : null;
    const statusText = 'statusText' in error ? String(error.statusText ?? '') : '';
    return statusCode === 404 || statusText.toLowerCase().includes('does not exist');
}
function describeFetchAccountError(error) {
    if (!error || typeof error !== 'object')
        return String(error);
    const statusCode = 'statusCode' in error ? error.statusCode : null;
    const statusText = 'statusText' in error ? error.statusText : null;
    return [statusCode, statusText].filter((entry) => entry !== null && entry !== undefined && String(entry).length > 0).join(' ');
}
async function main() {
    const graphql = assertActiveZekoEndpoint(requireEnv('ZEKO_GRAPHQL'), 'ZEKO_GRAPHQL');
    const archive = assertActiveZekoEndpoint(readOptionalEnv('ZEKO_ARCHIVE', graphql), 'ZEKO_ARCHIVE');
    const o1jsNetworkId = readOptionalEnv('ZEKO_O1JS_NETWORK_ID', 'testnet');
    const zkappAddress = PublicKey.fromBase58(requireEnv('X402_ZKAPP_PUBLIC_KEY'));
    Mina.setActiveInstance(Mina.Network({
        networkId: o1jsNetworkId,
        mina: graphql,
        archive
    }));
    const result = await fetchAccount({ publicKey: zkappAddress });
    if (result.error) {
        if (isFetchAccountNotFound(result.error)) {
            throw new Error(`x402 settlement zkapp not found at ${zkappAddress.toBase58()}`);
        }
        throw new Error(`Unable to fetch x402 settlement zkapp ${zkappAddress.toBase58()}: ${describeFetchAccountError(result.error)}`);
    }
    const zkapp = new X402SettlementContract(zkappAddress);
    console.log(JSON.stringify({
        ok: true,
        network: {
            id: readOptionalEnv('X402_ZEKO_NETWORK', 'zeko:sepolia'),
            nodeNetworkId: 'zeko:testnet',
            o1jsNetworkId,
            graphql,
            archive,
            nativeAsset: {
                symbol: 'sETH',
                decimals: 9,
                standard: 'native'
            }
        },
        zkappAddress: zkappAddress.toBase58(),
        beneficiary: zkapp.beneficiary.get().toBase58(),
        serviceCommitment: zkapp.serviceCommitment.get().toString(),
        settlementRoot: zkapp.settlementRoot.get().toString()
    }, null, 2));
}
main().catch((error) => {
    console.error('[zeko-x402:zkapp:get-state] failed', error);
    process.exit(1);
});
