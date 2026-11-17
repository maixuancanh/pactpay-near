import {readFile} from "node:fs/promises";
import {resolve} from "node:path";
import {fileURLToPath} from "node:url";
import {caseReader} from "../../lib/near-case-rpc.mjs";

// Read-only accounting. Attached deposits are transfers/storage reserves, not gas burn.
export function summarizeCost(result, ref, escrow) {
  const tx=result?.transaction;
  if(result?.final_execution_status!=="FINAL" || tx?.hash!==ref.hash || tx.signer_id!==ref.signer || tx.receiver_id!==escrow ||
    !result.transaction_outcome || !Array.isArray(result.receipts_outcome)) throw Error("Finalized transaction identity or outcomes unavailable.");
  let gas=0n, tokens=0n;
  const seen=new Set();
  for(const item of [result.transaction_outcome,...result.receipts_outcome]) {
    const o=item?.outcome;
    if(!item?.id || seen.has(item.id) || !Number.isSafeInteger(o?.gas_burnt) || o.gas_burnt<0 ||
      typeof o.tokens_burnt!=="string" || !/^(0|[1-9][0-9]*)$/.test(o.tokens_burnt)) throw Error("Invalid or duplicated execution outcome.");
    seen.add(item.id); gas+=BigInt(o.gas_burnt); tokens+=BigInt(o.tokens_burnt);
  }
  return {gasBurnt:gas.toString(),tokensBurntYoctoNEAR:tokens.toString()};
}

async function main() {
  const proof=JSON.parse(await readFile(process.argv[2]||"docs/near/testnet-workshop-ai-proof.json","utf8"));
  if(proof.network!=="testnet" || !proof.escrow?.endsWith(".testnet")) throw Error("Only a Testnet proof is supported.");
  const refs=[{step:"proposal",...proof.receipts.proposal},{step:"approval",...proof.receipts.approval},
    ...(proof.receipts.claims||[]).map((r,i)=>({step:`claim-${i+1}`,...r}))];
  if(new Set(refs.map(r=>r.hash)).size!==refs.length) throw Error("Duplicate transaction reference.");
  const reader=caseReader(AbortSignal.timeout(90000));
  const rows=[];
  for(const ref of refs) rows.push({...ref,...summarizeCost(await reader.transaction(ref.hash,ref.signer),ref,proof.escrow)});
  console.log(JSON.stringify({schema:"pactpay.case-cost.v1",measuredAt:new Date().toISOString(),network:"testnet",
    escrow:proof.escrow,booking:proof.proposal.booking,scope:"Only proposal, approval and claim transactions listed in this proof; not the full booking lifecycle.",
    rows,totalGasBurnt:rows.reduce((n,r)=>n+BigInt(r.gasBurnt),0n).toString(),
    totalTokensBurntYoctoNEAR:rows.reduce((n,r)=>n+BigInt(r.tokensBurntYoctoNEAR),0n).toString(),
    storageDeposit:"Not measured: attached deposits are not equivalent to net storage cost.",
    aiCost:"Not measured: this proof does not include provider billing.",
    multiParticipantBaseline:"Not measured: no extrapolation from one participant."},null,2));
}
if(process.argv[1] && resolve(process.argv[1])===fileURLToPath(import.meta.url)) main().catch(error=>{console.error(error.message);process.exitCode=1;});
