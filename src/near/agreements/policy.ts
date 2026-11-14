import type {AgreementV2} from "./types";

function uint(value: string, bits: number): bigint {
  if (typeof value !== "string" || value.length > 39 || !/^(0|[1-9][0-9]*)$/.test(value)) {
    throw new Error("Invalid unsigned decimal");
  }
  const result = BigInt(value);
  if (result >= 1n << BigInt(bits)) throw new Error("Value exceeds the supported range");
  return result;
}

export function checkSplit(total: string, buyer: string, merchant: string, retained: string): boolean {
  try {
    return uint(total, 128) === uint(buyer, 128) + uint(merchant, 128) + uint(retained, 128);
  } catch {
    return false;
  }
}

type Identity = Pick<AgreementV2, "network" | "escrow" | "booking" | "position" | "version" |
  "buyer" | "merchant" | "token" | "termsCommitment">;

export function validateAgreement(p: AgreementV2, expected: Identity, total: string, now: string, disputeUntil: string) {
  if (p.schema !== "pactpay.resolution.v2") throw new Error("Unsupported agreement schema");
  for (const key of Object.keys(expected) as (keyof Identity)[]) {
    if (p[key] !== expected[key]) throw new Error(`Agreement ${key} has changed`);
  }
  uint(p.booking, 64);
  uint(p.position, 8);
  uint(p.version, 64);
  const digests = [p.termsCommitment, p.evidenceRoot, p.privateTermsCommitment, p.salt];
  if (p.assessmentDigest !== null) digests.push(p.assessmentDigest);
  if (!digests.every(value => /^[a-f0-9]{64}$/.test(value))) throw new Error("Invalid agreement commitment");
  if (!checkSplit(total, p.immediateBuyer, p.immediateMerchant, p.retained) ||
      !checkSplit(p.retained, p.successBuyer, p.successMerchant, "0") ||
      !checkSplit(p.retained, p.fallbackBuyer, p.fallbackMerchant, "0")) {
    throw new Error("Agreement amounts must conserve the contribution");
  }
  const accept = uint(p.acceptBy, 64);
  const deliver = uint(p.deliverBy, 64);
  const review = uint(p.reviewUntil, 64);
  if (!(uint(now, 64) < accept && accept < deliver && deliver < review && review <= uint(disputeUntil, 64))) {
    throw new Error("Agreement deadlines are invalid or expired");
  }
}
