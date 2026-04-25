import { Field } from 'o1js';
import { createHash } from 'node:crypto';
export function requireEnv(name) {
    const value = process.env[name];
    if (!value || value.trim().length === 0) {
        throw new Error(`${name} env var is required`);
    }
    return value.trim();
}
export function readOptionalEnv(name, fallback) {
    const value = process.env[name];
    return value && value.trim().length > 0 ? value.trim() : fallback;
}
export function hashHexToField(hex) {
    const clean = hex.replace(/^0x/i, '').trim();
    if (!/^[0-9a-fA-F]+$/.test(clean)) {
        throw new Error('hex digest is required');
    }
    return Field(BigInt(`0x${clean}`));
}
export function hashStringToField(value) {
    return hashHexToField(createHash('sha256').update(value, 'utf8').digest('hex'));
}
export function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}
export function isGatewayTimeoutError(error) {
    const message = error instanceof Error ? error.message : String(error);
    return message.includes('504') || message.toLowerCase().includes('gateway timeout');
}
