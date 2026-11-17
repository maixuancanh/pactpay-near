import type {AgreementV2} from "./types";

export type OutcomeBranch = "immediate" | "success" | "fallback";

// Project the committed fields directly: no decimal conversion, inferred refund,
// or independent settlement calculation. These are allocations, not transfers.
export function previewAllocation(p: AgreementV2, branch: OutcomeBranch) {
  return {
    buyer: p[`${branch}Buyer`],
    merchant: p[`${branch}Merchant`],
    retained: branch === "immediate" ? p.retained : "0",
  };
}
