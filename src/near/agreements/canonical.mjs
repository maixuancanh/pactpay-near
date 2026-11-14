
export function canonicalAgreement(p) {
  return JSON.stringify([
    p.schema, p.network, p.escrow, p.booking, p.position, p.version,
    p.buyer, p.merchant, p.token, p.termsCommitment, p.evidenceRoot,
    p.privateTermsCommitment, p.assessmentDigest, p.immediateBuyer,
    p.immediateMerchant, p.retained, p.successBuyer, p.successMerchant,
    p.fallbackBuyer, p.fallbackMerchant, p.acceptBy, p.deliverBy,
    p.reviewUntil, p.salt,
  ]);
}

export async function agreementDigest(p) {
  const bytes = new TextEncoder().encode(canonicalAgreement(p));
  const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join("");
}
