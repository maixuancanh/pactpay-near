import type {AgreementRecord, ClaimRecord} from "./chain-v2";

export function nextResolutionAction({account, open, proposed, claims, agreement, buyer, merchant, time, canPropose}: {
  account?: string;
  open: boolean;
  proposed: boolean;
  claims?: readonly ClaimRecord[];
  agreement?: AgreementRecord | null;
  buyer: boolean;
  merchant: boolean;
  time: number;
  canPropose: boolean;
}): string | null {
  if (!account) return open || proposed ? "Connect your wallet to act on this agreement." : null;
  if (claims?.some(claim => claim.recipient === account && claim.status === "Available")) {
    return "Open Payments to claim your available payout or refund.";
  }
  if (open && agreement && time >= Number(agreement.proposal.reviewUntil)) return "Apply the signed deadline split.";
  if (!buyer && !merchant) return null;
  if (proposed && agreement) {
    return (agreement.approvals & (buyer ? 1 : 2))
      ? "Waiting for the other party to sign."
      : "Open the agreement terms in Private evidence, then go to Agreement to sign.";
  }
  if (agreement?.status === "Active") {
    if (time >= Number(agreement.proposal.deliverBy)) {
      return "The completion deadline passed. The signed deadline split becomes available after the review window.";
    }
    return merchant ? "Upload in Private evidence, then submit the selected evidence in Agreement."
      : "Waiting for the merchant to submit completion evidence.";
  }
  if (agreement?.status === "CompletionSubmitted") {
    return buyer ? "Review the merchant’s evidence, then use Agreement to confirm or object."
      : "Waiting for the buyer to review completion.";
  }
  return canPropose ? "Share the evidence, then open Agreement to commit it and propose a split." : null;
}
