var __decorate = (this && this.__decorate) || function (decorators, target, key, desc) {
    var c = arguments.length, r = c < 3 ? target : desc === null ? desc = Object.getOwnPropertyDescriptor(target, key) : desc, d;
    if (typeof Reflect === "object" && typeof Reflect.decorate === "function") r = Reflect.decorate(decorators, target, key, desc);
    else for (var i = decorators.length - 1; i >= 0; i--) if (d = decorators[i]) r = (c < 3 ? d(r) : c > 3 ? d(target, key, r) : d(target, key)) || r;
    return c > 3 && r && Object.defineProperty(target, key, r), r;
};
var __metadata = (this && this.__metadata) || function (k, v) {
    if (typeof Reflect === "object" && typeof Reflect.metadata === "function") return Reflect.metadata(k, v);
};
import 'reflect-metadata';
import { Field, MerkleMap, MerkleMapWitness, Permissions, Poseidon, PublicKey, SmartContract, State, Struct, UInt64, method, state } from 'o1js';
export class X402SettlementConfig extends Struct({
    beneficiary: PublicKey,
    serviceCommitment: Field
}) {
}
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
}) {
}
export class X402SettlementContract extends SmartContract {
    constructor() {
        super(...arguments);
        this.beneficiary = State();
        this.serviceCommitment = State();
        this.settlementRoot = State();
        this.events = {
            exactSettlement: X402ExactSettlementEvent
        };
    }
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
    async configure(config) {
        this.requireSignature();
        const currentBeneficiary = this.beneficiary.getAndRequireEquals();
        currentBeneficiary.isEmpty().assertTrue('beneficiary_already_configured');
        config.beneficiary.isEmpty().assertFalse('beneficiary_required');
        config.serviceCommitment.assertNotEquals(Field(0));
        this.beneficiary.set(config.beneficiary);
        this.serviceCommitment.set(config.serviceCommitment);
    }
    async rotateBeneficiary(nextBeneficiary) {
        this.requireSignature();
        nextBeneficiary.isEmpty().assertFalse('beneficiary_required');
        const currentServiceCommitment = this.serviceCommitment.getAndRequireEquals();
        currentServiceCommitment.assertNotEquals(Field(0));
        this.beneficiary.set(nextBeneficiary);
    }
    async settleExact(requestIdHash, paymentIdHash, payer, beneficiary, amountNanomina, paymentContextDigest, resourceDigest, paymentWitness) {
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
        this.emitEvent('exactSettlement', new X402ExactSettlementEvent({
            requestIdHash,
            paymentIdHash,
            payer,
            beneficiary,
            amountNanomina,
            paymentContextDigest,
            resourceDigest,
            settlementLeaf,
            settlementRoot: nextRoot
        }));
    }
}
__decorate([
    state(PublicKey),
    __metadata("design:type", Object)
], X402SettlementContract.prototype, "beneficiary", void 0);
__decorate([
    state(Field),
    __metadata("design:type", Object)
], X402SettlementContract.prototype, "serviceCommitment", void 0);
__decorate([
    state(Field),
    __metadata("design:type", Object)
], X402SettlementContract.prototype, "settlementRoot", void 0);
__decorate([
    method,
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [X402SettlementConfig]),
    __metadata("design:returntype", Promise)
], X402SettlementContract.prototype, "configure", null);
__decorate([
    method,
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [PublicKey]),
    __metadata("design:returntype", Promise)
], X402SettlementContract.prototype, "rotateBeneficiary", null);
__decorate([
    method,
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Field,
        Field,
        PublicKey,
        PublicKey,
        UInt64,
        Field,
        Field,
        MerkleMapWitness]),
    __metadata("design:returntype", Promise)
], X402SettlementContract.prototype, "settleExact", null);
