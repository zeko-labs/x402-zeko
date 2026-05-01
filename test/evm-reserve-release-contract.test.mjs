import assert from "node:assert/strict";
import test from "node:test";

import { ethers } from "ethers";
import ganache from "ganache";

import { loadCompiledArtifact } from "../scripts/lib/compile-evm-contracts.mjs";

const PAYER_PRIVATE_KEY = "0x1000000000000000000000000000000000000000000000000000000000000001";
const ADMIN_PRIVATE_KEY = "0x1000000000000000000000000000000000000000000000000000000000000002";
const RELEASER_PRIVATE_KEY = "0x1000000000000000000000000000000000000000000000000000000000000003";
const PAYTO_PRIVATE_KEY = "0x1000000000000000000000000000000000000000000000000000000000000004";
const FEE_PRIVATE_KEY = "0x1000000000000000000000000000000000000000000000000000000000000005";

function fundedAccount(secretKey) {
  return {
    secretKey,
    balance: `0x${ethers.parseEther("100").toString(16)}`
  };
}

async function deployContract(factoryArtifact, signer, args = []) {
  const factory = new ethers.ContractFactory(factoryArtifact.abi, factoryArtifact.bytecode, signer);
  const contract = await factory.deploy(...args);
  await contract.waitForDeployment();
  return contract;
}

async function setupContracts(escrowContractName = "X402BaseUSDCReserveEscrow") {
  const eip1193Provider = ganache.provider({
    logging: { quiet: true },
    wallet: {
      accounts: [
        fundedAccount(PAYER_PRIVATE_KEY),
        fundedAccount(ADMIN_PRIVATE_KEY),
        fundedAccount(RELEASER_PRIVATE_KEY),
        fundedAccount(PAYTO_PRIVATE_KEY),
        fundedAccount(FEE_PRIVATE_KEY)
      ]
    }
  });
  const provider = new ethers.BrowserProvider(eip1193Provider);
  const payer = new ethers.Wallet(PAYER_PRIVATE_KEY, provider);
  const admin = new ethers.Wallet(ADMIN_PRIVATE_KEY, provider);
  const releaser = new ethers.Wallet(RELEASER_PRIVATE_KEY, provider);
  const payTo = new ethers.Wallet(PAYTO_PRIVATE_KEY, provider);
  const protocolFeeRecipient = new ethers.Wallet(FEE_PRIVATE_KEY, provider);

  const usdcArtifact = await loadCompiledArtifact("MockUSDC3009");
  const escrowArtifact = await loadCompiledArtifact(escrowContractName);
  const usdc = await deployContract(usdcArtifact, admin);
  const escrow = await deployContract(escrowArtifact, releaser, [
    await usdc.getAddress(),
    admin.address,
    releaser.address
  ]);

  return {
    eip1193Provider,
    provider,
    payer,
    admin,
    releaser,
    payTo,
    protocolFeeRecipient,
    usdc,
    escrow
  };
}

async function signTransferWithAuthorization({
  payer,
  tokenAddress,
  chainId,
  to,
  value,
  validAfter = 0n,
  validBefore,
  nonce
}) {
  const domain = {
    name: "USD Coin",
    version: "2",
    chainId,
    verifyingContract: tokenAddress
  };
  const types = {
    TransferWithAuthorization: [
      { name: "from", type: "address" },
      { name: "to", type: "address" },
      { name: "value", type: "uint256" },
      { name: "validAfter", type: "uint256" },
      { name: "validBefore", type: "uint256" },
      { name: "nonce", type: "bytes32" }
    ]
  };
  const message = {
    from: payer.address,
    to,
    value,
    validAfter,
    validBefore,
    nonce
  };

  const signature = await payer.signTypedData(domain, types, message);
  return {
    ...message,
    signature: ethers.Signature.from(signature)
  };
}

test("reserve-release escrow can reserve then release Base-style USDC authorization funds", async () => {
  const { provider, payer, releaser, payTo, usdc, escrow } = await setupContracts();
  const amount = 125_000n;
  const requestIdHash = ethers.keccak256(ethers.toUtf8Bytes("req_demo"));
  const paymentIdHash = ethers.keccak256(ethers.toUtf8Bytes("pay_demo"));
  const resultCommitment = ethers.keccak256(ethers.toUtf8Bytes("proof_demo"));
  const expiry = BigInt(Math.floor(Date.now() / 1000) + 3600);

  await (await usdc.mint(payer.address, amount)).wait();

  const signaturePayload = await signTransferWithAuthorization({
    payer,
    tokenAddress: await usdc.getAddress(),
    chainId: (await provider.getNetwork()).chainId,
    to: await escrow.getAddress(),
    value: amount,
    validBefore: BigInt(Math.floor(Date.now() / 1000) + 3600),
    nonce: ethers.keccak256(ethers.toUtf8Bytes("nonce_release"))
  });

  await (
    await escrow.reserveExactWithAuthorization(
      requestIdHash,
      paymentIdHash,
      payer.address,
      payTo.address,
      await usdc.getAddress(),
      amount,
      signaturePayload.validAfter,
      signaturePayload.validBefore,
      signaturePayload.nonce,
      resultCommitment,
      expiry,
      signaturePayload.signature.v,
      signaturePayload.signature.r,
      signaturePayload.signature.s
    )
  ).wait();

  const reservation = await escrow.reservationOf(requestIdHash, paymentIdHash);
  assert.equal(reservation.payer, payer.address);
  assert.equal(reservation.payTo, payTo.address);
  assert.equal(reservation.amount, amount);
  assert.equal(reservation.resultCommitment, resultCommitment);
  assert.equal(await usdc.balanceOf(await escrow.getAddress()), amount);

  await (await escrow.connect(releaser).releaseReservedPayment(requestIdHash, paymentIdHash, resultCommitment)).wait();

  assert.equal(await usdc.balanceOf(payTo.address), amount);
  assert.equal(await usdc.balanceOf(await escrow.getAddress()), 0n);
});

test("reserve-release escrow v3 splits release between seller and protocol fee recipient", async () => {
  const { provider, payer, releaser, payTo, protocolFeeRecipient, usdc, escrow } = await setupContracts(
    "X402BaseUSDCReserveEscrowV3"
  );
  const grossAmount = 500_000n;
  const sellerAmount = 495_000n;
  const protocolFeeAmount = 5_000n;
  const requestIdHash = ethers.keccak256(ethers.toUtf8Bytes("req_demo_fee"));
  const paymentIdHash = ethers.keccak256(ethers.toUtf8Bytes("pay_demo_fee"));
  const resultCommitment = ethers.keccak256(ethers.toUtf8Bytes("proof_demo_fee"));
  const expiry = BigInt(Math.floor(Date.now() / 1000) + 3600);

  await (await usdc.mint(payer.address, grossAmount)).wait();

  const signaturePayload = await signTransferWithAuthorization({
    payer,
    tokenAddress: await usdc.getAddress(),
    chainId: (await provider.getNetwork()).chainId,
    to: await escrow.getAddress(),
    value: grossAmount,
    validBefore: BigInt(Math.floor(Date.now() / 1000) + 3600),
    nonce: ethers.keccak256(ethers.toUtf8Bytes("nonce_fee_release"))
  });

  await (
    await escrow.reserveExactWithAuthorizationSplit(
      requestIdHash,
      paymentIdHash,
      payer.address,
      payTo.address,
      protocolFeeRecipient.address,
      await usdc.getAddress(),
      grossAmount,
      sellerAmount,
      protocolFeeAmount,
      100,
      signaturePayload.validAfter,
      signaturePayload.validBefore,
      signaturePayload.nonce,
      resultCommitment,
      expiry,
      signaturePayload.signature.v,
      signaturePayload.signature.r,
      signaturePayload.signature.s
    )
  ).wait();

  const reservation = await escrow.reservationOf(requestIdHash, paymentIdHash);
  assert.equal(reservation.sellerPayTo, payTo.address);
  assert.equal(reservation.protocolFeePayTo, protocolFeeRecipient.address);
  assert.equal(reservation.grossAmount, grossAmount);
  assert.equal(reservation.sellerAmount, sellerAmount);
  assert.equal(reservation.protocolFeeAmount, protocolFeeAmount);

  await (await escrow.connect(releaser).releaseReservedPayment(requestIdHash, paymentIdHash, resultCommitment)).wait();

  assert.equal(await usdc.balanceOf(payTo.address), sellerAmount);
  assert.equal(await usdc.balanceOf(protocolFeeRecipient.address), protocolFeeAmount);
  assert.equal(await usdc.balanceOf(await escrow.getAddress()), 0n);
});

test("reserve-release escrow v4 keeps the protocol fee on reserve and refunds only the seller amount", async () => {
  const { eip1193Provider, provider, payer, releaser, payTo, protocolFeeRecipient, usdc, escrow } = await setupContracts(
    "X402BaseUSDCReserveEscrowV4"
  );
  const grossAmount = 500_000n;
  const sellerAmount = 495_000n;
  const protocolFeeAmount = 5_000n;
  const requestIdHash = ethers.keccak256(ethers.toUtf8Bytes("req_demo_fee_on_reserve"));
  const paymentIdHash = ethers.keccak256(ethers.toUtf8Bytes("pay_demo_fee_on_reserve"));
  const resultCommitment = ethers.keccak256(ethers.toUtf8Bytes("proof_demo_fee_on_reserve"));
  const currentBlock = await provider.getBlock("latest");
  const now = BigInt(currentBlock.timestamp);
  const expiry = now + 30n;

  await (await usdc.mint(payer.address, grossAmount)).wait();

  const signaturePayload = await signTransferWithAuthorization({
    payer,
    tokenAddress: await usdc.getAddress(),
    chainId: (await provider.getNetwork()).chainId,
    to: await escrow.getAddress(),
    value: grossAmount,
    validBefore: now + 3600n,
    nonce: ethers.keccak256(ethers.toUtf8Bytes("nonce_fee_on_reserve"))
  });

  await (
    await escrow.reserveExactWithAuthorizationSplitImmediateFee(
      requestIdHash,
      paymentIdHash,
      payer.address,
      payTo.address,
      protocolFeeRecipient.address,
      await usdc.getAddress(),
      grossAmount,
      sellerAmount,
      protocolFeeAmount,
      100,
      signaturePayload.validAfter,
      signaturePayload.validBefore,
      signaturePayload.nonce,
      resultCommitment,
      expiry,
      signaturePayload.signature.v,
      signaturePayload.signature.r,
      signaturePayload.signature.s
    )
  ).wait();

  const reservation = await escrow.reservationOf(requestIdHash, paymentIdHash);
  assert.equal(reservation.sellerAmount, sellerAmount);
  assert.equal(reservation.protocolFeeAmount, protocolFeeAmount);
  assert.equal(await usdc.balanceOf(protocolFeeRecipient.address), protocolFeeAmount);
  assert.equal(await usdc.balanceOf(await escrow.getAddress()), sellerAmount);

  await eip1193Provider.request({
    method: "evm_increaseTime",
    params: [60]
  });
  await eip1193Provider.request({
    method: "evm_mine",
    params: []
  });

  const payerBalanceBeforeRefund = await usdc.balanceOf(payer.address);
  await (await escrow.refundExpiredPayment(requestIdHash, paymentIdHash)).wait();
  const payerBalanceAfterRefund = await usdc.balanceOf(payer.address);

  assert.equal(payerBalanceAfterRefund - payerBalanceBeforeRefund, sellerAmount);
  assert.equal(await usdc.balanceOf(protocolFeeRecipient.address), protocolFeeAmount);
  assert.equal(await usdc.balanceOf(await escrow.getAddress()), 0n);

  const {
    provider: releaseProvider,
    payer: releasePayer,
    releaser: releaseReleaser,
    payTo: releasePayTo,
    protocolFeeRecipient: releaseProtocolFeeRecipient,
    usdc: releaseUsdc,
    escrow: releaseEscrow
  } = await setupContracts("X402BaseUSDCReserveEscrowV4");
  const releaseRequestIdHash = ethers.keccak256(ethers.toUtf8Bytes("req_demo_fee_on_reserve_release"));
  const releasePaymentIdHash = ethers.keccak256(ethers.toUtf8Bytes("pay_demo_fee_on_reserve_release"));
  const releaseResultCommitment = ethers.keccak256(ethers.toUtf8Bytes("proof_demo_fee_on_reserve_release"));
  const releaseExpiry = BigInt(Math.floor(Date.now() / 1000) + 3600);

  await (await releaseUsdc.mint(releasePayer.address, grossAmount)).wait();

  const releaseSignature = await signTransferWithAuthorization({
    payer: releasePayer,
    tokenAddress: await releaseUsdc.getAddress(),
    chainId: (await releaseProvider.getNetwork()).chainId,
    to: await releaseEscrow.getAddress(),
    value: grossAmount,
    validBefore: BigInt(Math.floor(Date.now() / 1000) + 3600),
    nonce: ethers.keccak256(ethers.toUtf8Bytes("nonce_fee_on_reserve_release"))
  });

  await (
    await releaseEscrow.reserveExactWithAuthorizationSplitImmediateFee(
      releaseRequestIdHash,
      releasePaymentIdHash,
      releasePayer.address,
      releasePayTo.address,
      releaseProtocolFeeRecipient.address,
      await releaseUsdc.getAddress(),
      grossAmount,
      sellerAmount,
      protocolFeeAmount,
      100,
      releaseSignature.validAfter,
      releaseSignature.validBefore,
      releaseSignature.nonce,
      releaseResultCommitment,
      releaseExpiry,
      releaseSignature.signature.v,
      releaseSignature.signature.r,
      releaseSignature.signature.s
    )
  ).wait();

  await (
    await releaseEscrow
      .connect(releaseReleaser)
      .releaseReservedPayment(releaseRequestIdHash, releasePaymentIdHash, releaseResultCommitment)
  ).wait();

  assert.equal(await releaseUsdc.balanceOf(releasePayTo.address), sellerAmount);
  assert.equal(await releaseUsdc.balanceOf(releaseProtocolFeeRecipient.address), protocolFeeAmount);
  assert.equal(await releaseUsdc.balanceOf(await releaseEscrow.getAddress()), 0n);
});

test("reserve-release escrow only allows the releaser role to create reservations", async () => {
  const { provider, payer, payTo, usdc, escrow } = await setupContracts();
  const amount = 77_000n;
  const requestIdHash = ethers.keccak256(ethers.toUtf8Bytes("req_role_gate"));
  const paymentIdHash = ethers.keccak256(ethers.toUtf8Bytes("pay_role_gate"));
  const resultCommitment = ethers.keccak256(ethers.toUtf8Bytes("proof_role_gate"));
  const expiry = BigInt(Math.floor(Date.now() / 1000) + 3600);

  await (await usdc.mint(payer.address, amount)).wait();

  const signaturePayload = await signTransferWithAuthorization({
    payer,
    tokenAddress: await usdc.getAddress(),
    chainId: (await provider.getNetwork()).chainId,
    to: await escrow.getAddress(),
    value: amount,
    validBefore: BigInt(Math.floor(Date.now() / 1000) + 3600),
    nonce: ethers.keccak256(ethers.toUtf8Bytes("nonce_role_gate"))
  });

  await assert.rejects(async () => {
    await (
      await escrow.connect(payer).reserveExactWithAuthorization(
        requestIdHash,
        paymentIdHash,
        payer.address,
        payTo.address,
        await usdc.getAddress(),
        amount,
        signaturePayload.validAfter,
        signaturePayload.validBefore,
        signaturePayload.nonce,
        resultCommitment,
        expiry,
        signaturePayload.signature.v,
        signaturePayload.signature.r,
        signaturePayload.signature.s
      )
    ).wait();
  });
  const reservation = await escrow.reservationOf(requestIdHash, paymentIdHash);
  assert.equal(reservation.status, 0n);
  assert.equal(await usdc.balanceOf(await escrow.getAddress()), 0n);
});

test("reserve-release escrow does not allow releasing an expired reservation", async () => {
  const { eip1193Provider, provider, payer, payTo, releaser, usdc, escrow } = await setupContracts();
  const amount = 66_000n;
  const requestIdHash = ethers.keccak256(ethers.toUtf8Bytes("req_expired_release"));
  const paymentIdHash = ethers.keccak256(ethers.toUtf8Bytes("pay_expired_release"));
  const resultCommitment = ethers.keccak256(ethers.toUtf8Bytes("proof_expired_release"));
  const currentBlock = await provider.getBlock("latest");
  const now = BigInt(currentBlock.timestamp);
  const expiry = now + 20n;

  await (await usdc.mint(payer.address, amount)).wait();

  const signaturePayload = await signTransferWithAuthorization({
    payer,
    tokenAddress: await usdc.getAddress(),
    chainId: (await provider.getNetwork()).chainId,
    to: await escrow.getAddress(),
    value: amount,
    validBefore: now + 3600n,
    nonce: ethers.keccak256(ethers.toUtf8Bytes("nonce_expired_release"))
  });

  await (
    await escrow.reserveExactWithAuthorization(
      requestIdHash,
      paymentIdHash,
      payer.address,
      payTo.address,
      await usdc.getAddress(),
      amount,
      signaturePayload.validAfter,
      signaturePayload.validBefore,
      signaturePayload.nonce,
      resultCommitment,
      expiry,
      signaturePayload.signature.v,
      signaturePayload.signature.r,
      signaturePayload.signature.s
    )
  ).wait();

  await eip1193Provider.request({
    method: "evm_increaseTime",
    params: [60]
  });
  await eip1193Provider.request({
    method: "evm_mine",
    params: []
  });

  await assert.rejects(async () => {
    await (
      await escrow.connect(releaser).releaseReservedPayment(requestIdHash, paymentIdHash, resultCommitment)
    ).wait();
  });
  assert.equal(await usdc.balanceOf(payTo.address), 0n);
  assert.equal(await usdc.balanceOf(await escrow.getAddress()), amount);
});

test("reserve-release escrow can refund expired reservations back to the payer", async () => {
  const { eip1193Provider, provider, payer, payTo, usdc, escrow } = await setupContracts();
  const amount = 98_000n;
  const requestIdHash = ethers.keccak256(ethers.toUtf8Bytes("req_refund"));
  const paymentIdHash = ethers.keccak256(ethers.toUtf8Bytes("pay_refund"));
  const resultCommitment = ethers.keccak256(ethers.toUtf8Bytes("proof_refund"));
  const currentBlock = await provider.getBlock("latest");
  const now = BigInt(currentBlock.timestamp);
  const expiry = now + 30n;

  await (await usdc.mint(payer.address, amount)).wait();

  const signaturePayload = await signTransferWithAuthorization({
    payer,
    tokenAddress: await usdc.getAddress(),
    chainId: (await provider.getNetwork()).chainId,
    to: await escrow.getAddress(),
    value: amount,
    validBefore: now + 3600n,
    nonce: ethers.keccak256(ethers.toUtf8Bytes("nonce_refund"))
  });

  await (
    await escrow.reserveExactWithAuthorization(
      requestIdHash,
      paymentIdHash,
      payer.address,
      payTo.address,
      await usdc.getAddress(),
      amount,
      signaturePayload.validAfter,
      signaturePayload.validBefore,
      signaturePayload.nonce,
      resultCommitment,
      expiry,
      signaturePayload.signature.v,
      signaturePayload.signature.r,
      signaturePayload.signature.s
    )
  ).wait();

  await eip1193Provider.request({
    method: "evm_increaseTime",
    params: [60]
  });
  await eip1193Provider.request({
    method: "evm_mine",
    params: []
  });

  const payerBalanceBeforeRefund = await usdc.balanceOf(payer.address);
  await (await escrow.refundExpiredPayment(requestIdHash, paymentIdHash)).wait();
  const payerBalanceAfterRefund = await usdc.balanceOf(payer.address);

  assert.equal(payerBalanceAfterRefund - payerBalanceBeforeRefund, amount);
  assert.equal(await usdc.balanceOf(await escrow.getAddress()), 0n);
});

test("seller escrow factory deploys one isolated V4 escrow per seller id", async () => {
  const { provider, admin, releaser, usdc } = await setupContracts("X402BaseUSDCReserveEscrowV4");
  const factoryArtifact = await loadCompiledArtifact("X402BaseUSDCReserveEscrowV4Factory");
  const escrowArtifact = await loadCompiledArtifact("X402BaseUSDCReserveEscrowV4");
  const factory = await deployContract(factoryArtifact, admin, [
    await usdc.getAddress(),
    admin.address,
    releaser.address
  ]);
  const sellerIdHash = ethers.keccak256(ethers.toUtf8Bytes("seller:demo"));

  await (await factory.connect(releaser).createSellerEscrow(sellerIdHash, admin.address, releaser.address)).wait();

  const escrowAddress = await factory.sellerEscrowOf(sellerIdHash);
  const sellerEscrow = new ethers.Contract(escrowAddress, escrowArtifact.abi, provider);
  const releaserRole = await sellerEscrow.RELEASER_ROLE();

  assert.equal(await sellerEscrow.usdc(), await usdc.getAddress());
  assert.equal(await sellerEscrow.hasRole(ethers.ZeroHash, admin.address), true);
  assert.equal(await sellerEscrow.hasRole(releaserRole, releaser.address), true);

  await assert.rejects(async () => {
    await (
      await factory.connect(releaser).createSellerEscrow(sellerIdHash, admin.address, releaser.address)
    ).wait();
  });
});
