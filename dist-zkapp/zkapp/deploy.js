import 'reflect-metadata';
import { AccountUpdate, fetchAccount, Mina, PrivateKey, PublicKey, UInt64 } from 'o1js';
import { X402SettlementConfig, X402SettlementContract } from '../contracts/X402SettlementContract.js';
import { hashStringToField, isGatewayTimeoutError, readOptionalEnv, requireEnv, sleep } from './utils.js';
async function accountExists(publicKey) {
    try {
        const result = await fetchAccount({ publicKey });
        return !result.error;
    }
    catch {
        return false;
    }
}
async function readAccountNonce(publicKey) {
    try {
        const result = await fetchAccount({ publicKey });
        if (result.error)
            return null;
        const nonceLike = result?.account?.nonce;
        if (nonceLike && typeof nonceLike.toBigInt === 'function')
            return nonceLike.toBigInt();
        if (nonceLike && typeof nonceLike.toString === 'function')
            return BigInt(nonceLike.toString());
        return null;
    }
    catch {
        return null;
    }
}
async function waitForAccountVisible(publicKey, attempts = 40, intervalMs = 3000) {
    for (let index = 0; index < attempts; index += 1) {
        try {
            const result = await fetchAccount({ publicKey });
            if (!result.error)
                return true;
        }
        catch {
        }
        await sleep(intervalMs);
    }
    return false;
}
async function waitForNonceAtLeast(publicKey, minimumNonce, attempts = 40, intervalMs = 3000) {
    for (let index = 0; index < attempts; index += 1) {
        const nonce = await readAccountNonce(publicKey);
        if (nonce !== null && nonce >= minimumNonce)
            return nonce;
        await sleep(intervalMs);
    }
    return null;
}
async function waitForConfiguration(zkapp, zkappAddress, beneficiary, serviceCommitment, attempts = 40, intervalMs = 3000) {
    for (let index = 0; index < attempts; index += 1) {
        try {
            await fetchAccount({ publicKey: zkappAddress });
            if (zkapp.beneficiary.get().equals(beneficiary).toBoolean() &&
                zkapp.serviceCommitment.get().equals(serviceCommitment).toBoolean()) {
                return true;
            }
        }
        catch {
        }
        await sleep(intervalMs);
    }
    return false;
}
async function main() {
    const graphql = requireEnv('ZEKO_GRAPHQL');
    const archive = readOptionalEnv('ZEKO_ARCHIVE', graphql);
    const txFee = UInt64.from(readOptionalEnv('TX_FEE', '2000000000'));
    const deployerKey = PrivateKey.fromBase58(requireEnv('DEPLOYER_PRIVATE_KEY'));
    const zkappKey = PrivateKey.fromBase58(requireEnv('ZKAPP_PRIVATE_KEY'));
    const beneficiary = PublicKey.fromBase58(requireEnv('X402_BENEFICIARY_PUBLIC_KEY'));
    const serviceCommitmentInput = readOptionalEnv('X402_SERVICE_COMMITMENT', 'zeko-x402');
    const serviceCommitment = hashStringToField(serviceCommitmentInput);
    const deployerPublicKey = deployerKey.toPublicKey();
    const zkappAddress = zkappKey.toPublicKey();
    Mina.setActiveInstance(Mina.Network({
        mina: graphql,
        archive
    }));
    console.log('[zeko-x402:zkapp:deploy] compiling contract...');
    await X402SettlementContract.compile();
    const zkapp = new X402SettlementContract(zkappAddress);
    const startingNonce = (await readAccountNonce(deployerPublicKey)) ?? 0n;
    const alreadyExists = await accountExists(zkappAddress);
    console.log('[zeko-x402:zkapp:deploy] sending deploy tx...');
    const deployTx = await Mina.transaction({
        sender: deployerPublicKey,
        fee: txFee
    }, async () => {
        if (!alreadyExists) {
            AccountUpdate.fundNewAccount(deployerPublicKey);
        }
        await zkapp.deploy();
    });
    await deployTx.prove();
    deployTx.sign([deployerKey, zkappKey]);
    let sentDeploy = null;
    try {
        sentDeploy = await deployTx.send();
    }
    catch (error) {
        if (!isGatewayTimeoutError(error))
            throw error;
        console.warn('[zeko-x402:zkapp:deploy] deploy send timed out; checking chain state...');
    }
    const visible = await waitForAccountVisible(zkappAddress);
    if (!visible) {
        throw new Error('zkapp account not visible after deploy tx');
    }
    const deployerNonce = await waitForNonceAtLeast(deployerPublicKey, startingNonce + 1n);
    if (deployerNonce === null) {
        throw new Error('deployer nonce did not advance after deploy tx');
    }
    await fetchAccount({ publicKey: deployerPublicKey });
    await fetchAccount({ publicKey: zkappAddress });
    console.log('[zeko-x402:zkapp:deploy] sending configure tx...');
    const configureTx = await Mina.transaction({
        sender: deployerPublicKey,
        fee: txFee
    }, async () => {
        await zkapp.configure(new X402SettlementConfig({
            beneficiary,
            serviceCommitment
        }));
    });
    await configureTx.prove();
    configureTx.sign([deployerKey, zkappKey]);
    let sentConfigure = null;
    try {
        sentConfigure = await configureTx.send();
    }
    catch (error) {
        if (!isGatewayTimeoutError(error))
            throw error;
        console.warn('[zeko-x402:zkapp:deploy] configure send timed out; checking chain state...');
    }
    const configured = await waitForConfiguration(zkapp, zkappAddress, beneficiary, serviceCommitment);
    if (!configured) {
        throw new Error('configure tx not observed on-chain yet');
    }
    console.log(JSON.stringify({
        ok: true,
        zkappAddress: zkappAddress.toBase58(),
        beneficiary: beneficiary.toBase58(),
        serviceCommitment: serviceCommitment.toString(),
        serviceCommitmentInput,
        deployTxHash: sentDeploy?.hash ?? null,
        deployStatus: sentDeploy?.status ?? 'unknown (timeout but account became visible)',
        configureTxHash: sentConfigure?.hash ?? null,
        configureStatus: sentConfigure?.status ?? 'unknown (timeout but configuration observed)'
    }, null, 2));
}
main().catch((error) => {
    console.error('[zeko-x402:zkapp:deploy] failed', error);
    process.exit(1);
});
