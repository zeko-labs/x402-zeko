import { Field } from 'o1js';
import { createHash } from 'node:crypto';

export function requireEnv(name: string): string {
  const value = process.env[name];

  if (!value || value.trim().length === 0) {
    throw new Error(`${name} env var is required`);
  }

  return value.trim();
}

export function readOptionalEnv(name: string, fallback: string): string {
  const value = process.env[name];
  return value && value.trim().length > 0 ? value.trim() : fallback;
}

export function hashHexToField(hex: string): Field {
  const clean = hex.replace(/^0x/i, '').trim();

  if (!/^[0-9a-fA-F]+$/.test(clean)) {
    throw new Error('hex digest is required');
  }

  return Field(BigInt(`0x${clean}`));
}

export function hashStringToField(value: string): Field {
  return hashHexToField(createHash('sha256').update(value, 'utf8').digest('hex'));
}

export function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function isGatewayTimeoutError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes('504') || message.toLowerCase().includes('gateway timeout');
}
