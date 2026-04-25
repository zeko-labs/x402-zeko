import { createHash } from "node:crypto";

function normalize(value) {
  if (Array.isArray(value)) {
    return value.map((item) => normalize(item));
  }

  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entryValue]) => [key, normalize(entryValue)])
    );
  }

  return value;
}

export function stableStringify(value) {
  return JSON.stringify(normalize(value));
}

export function canonicalDigest(value) {
  const stableJson = stableStringify(value);
  const sha256Hex = createHash("sha256").update(stableJson).digest("hex");

  return {
    stableJson,
    sha256Hex
  };
}
