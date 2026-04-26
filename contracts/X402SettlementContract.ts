import 'reflect-metadata';

import {
  Field,
  MerkleMap,
  MerkleMapWitness,
  Permissions,
  Poseidon,
  PublicKey,
  SmartContract,
  State,
  Struct,
  UInt64,
  method,
  state
} from 'o1js';

export class X402SettlementConfig extends Struct({
  beneficiary: PublicKey,
  serviceCommitment: Field
}) {}

export class X402ExactSettlementEvent extends Struct({
  requestIdHash: Field,
  paymentIdHash: Field,
  payer: PublicKey,
  beneficiary: PublicKey,
  amountNanomina: UInt64,
  paymentContextDigest: Field,
  resourceDigest: Field,
  settlementLeaf: Field,
  settlementRoot: Field
}) {}

export class X402SettlementContract extends SmartContract {
  @state(PublicKey) beneficiary = State<PublicKey>();
  @state(Field) serviceCommitment = State<Field>();
  @state(Field) settlementRoot = State<Field>();

  events = {
    exactSettlement: X402ExactSettlementEvent
  };

  init() {
    super.init();
    this.beneficiary.set(PublicKey.empty());
    this.serviceCommitment.set(Field(0));
    this.settlementRoot.set(new MerkleMap().getRoot());
    this.account.permissions.set({
      ...Permissions.default(),
      editState: Permissions.proofOrSignature(),
      setPermissions: Permissions.signature()
    });
  }

  @method async configure(config: X402SettlementConfig) {
    this.requireSignature();
    const currentBeneficiary = this.beneficiary.getAndRequireEquals();
    currentBeneficiary.isEmpty().assertTrue('beneficiary_already_configured');
    config.beneficiary.isEmpty().assertFalse('beneficiary_required');
    config.serviceCommitment.assertNotEquals(Field(0));

    this.beneficiary.set(config.beneficiary);
    this.serviceCommitment.set(config.serviceCommitment);
  }

  @method async rotateBeneficiary(nextBeneficiary: PublicKey) {
    this.requireSignature();
    nextBeneficiary.isEmpty().assertFalse('beneficiary_required');

    const currentServiceCommitment = this.serviceCommitment.getAndRequireEquals();
    currentServiceCommitment.assertNotEquals(Field(0));
    this.beneficiary.set(nextBeneficiary);
  }

  @method async settleExact(
    requestIdHash: Field,
    paymentIdHash: Field,
    payer: PublicKey,
    beneficiary: PublicKey,
    amountNanomina: UInt64,
    paymentContextDigest: Field,
    resourceDigest: Field,
    paymentWitness: MerkleMapWitness
  ) {
    const configuredBeneficiary = this.beneficiary.getAndRequireEquals();
    const currentServiceCommitment = this.serviceCommitment.getAndRequireEquals();
    const currentRoot = this.settlementRoot.getAndRequireEquals();

    configuredBeneficiary.assertEquals(beneficiary);
    currentServiceCommitment.assertNotEquals(Field(0));
    amountNanomina.assertGreaterThan(UInt64.zero);

    const paymentKey = Poseidon.hash([requestIdHash, paymentIdHash]);
    const settlementLeaf = Poseidon.hash([
      requestIdHash,
      paymentIdHash,
      ...payer.toFields(),
      ...beneficiary.toFields(),
      amountNanomina.value,
      paymentContextDigest,
      resourceDigest,
      currentServiceCommitment
    ]);

    const [rootBefore, keyBefore] = paymentWitness.computeRootAndKey(Field(0));
    rootBefore.assertEquals(currentRoot);
    keyBefore.assertEquals(paymentKey);

    const [nextRoot] = paymentWitness.computeRootAndKey(settlementLeaf);
    this.settlementRoot.set(nextRoot);

    this.emitEvent(
      'exactSettlement',
      new X402ExactSettlementEvent({
        requestIdHash,
        paymentIdHash,
        payer,
        beneficiary,
        amountNanomina,
        paymentContextDigest,
        resourceDigest,
        settlementLeaf,
        settlementRoot: nextRoot
      })
    );
  }
}
