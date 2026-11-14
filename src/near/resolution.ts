export interface Resolution {
  network: "testnet";
  contract: string;
  booking: string;
  position: string;
  termsRevision: number;
  evidenceRevision: number;
  nonce: string;
  merchant: string;
  buyer: string;
  token: string;
  refund: string;
  payout: string;
  expiresAt: number;
}

function amount(value: string): bigint {
  if (!/^(0|[1-9][0-9]*)$/.test(value)) throw new Error("Invalid atomic amount");
  return BigInt(value);
}

/** Validates a proposal before presenting it for approval. The contract repeats these checks. */
export function validateResolution(
  proposal: Resolution,
  held: string,
  currentTermsRevision: number,
  currentEvidenceRevision: number,
  now: number,
): void {
  if (!Number.isSafeInteger(now) || !Number.isSafeInteger(proposal.expiresAt))
    throw new Error("Invalid timestamp");
  if (now >= proposal.expiresAt) throw new Error("Proposal expired");
  if (proposal.termsRevision !== currentTermsRevision ||
      proposal.evidenceRevision !== currentEvidenceRevision)
    throw new Error("Stale proposal");
  if (amount(proposal.refund) + amount(proposal.payout) !== amount(held))
    throw new Error("Allocation must equal held funds");
  for (const value of [proposal.contract, proposal.booking, proposal.position,
    proposal.nonce, proposal.merchant, proposal.buyer, proposal.token]) {
    if (!value.trim()) throw new Error("Missing proposal identity");
  }
}

/** Fixed field order prevents object insertion order from changing the commitment. */
export function resolutionPayload(p: Resolution): string {
  return JSON.stringify([
    "pactpay.near.resolution.v1", p.network, p.contract, p.booking,
    p.position, p.termsRevision, p.evidenceRevision, p.nonce,
    p.merchant, p.buyer, p.token, p.refund, p.payout, p.expiresAt,
  ]);
}
