import {view} from "../chain";
import type {AgreementV2} from "./types";

export const v2Escrow = import.meta.env.VITE_NEAR_ESCROW_V2?.trim() || "";
export type AgreementRecord = {
  proposal: AgreementV2;
  digest: string;
  status: "Proposed" | "Expired" | "Active" | "CompletionSubmitted" | "Completed" | "FallbackAllocated";
  approvals: number;
  completion_evidence_root: string | null;
  objection_evidence_root: string | null;
};
export type ClaimRecord = {
  claim_id: string;
  recipient: string;
  amount: string;
  status: "Available" | "Pending" | "Paid";
};
export type PositionLedger = Record<"funded" | "unallocated" | "retained" | "available" | "pending" | "paid", string>;

async function readClaims(escrow: string,args: {id: number; index: number}) {
  const claims: ClaimRecord[] = [];
  for (let from_index = 0; from_index < 256; from_index += 20) {
    const limit = Math.min(20,256-from_index);
    const page = await view<ClaimRecord[]>(escrow,"get_claims",{...args,from_index,limit});
    claims.push(...page);
    if (page.length < limit) break;
  }
  return claims;
}

export async function readResolution(escrow: string, id: number, index: number) {
  const args = {id, index};
  const [agreement, claims, ledger] = await Promise.all([
    view<AgreementRecord | null>(escrow, "get_agreement", args),
    readClaims(escrow,args),
    view<PositionLedger>(escrow, "get_position_ledger", args),
  ]);
  const retryEnabled=await view<boolean>(await view<string>(escrow,"get_token"),"payout_enabled",{escrow}).catch(()=>false);
  const retryable=retryEnabled ? await Promise.all(claims.filter(claim=>claim.status==="Pending").map(async claim=>
    await view<boolean>(escrow,"is_retryable_claim",{claim_id:claim.claim_id}).catch(()=>false) ? claim.claim_id : "")) : [];
  return {agreement, claims, ledger, retryEnabled, retryable};
}
