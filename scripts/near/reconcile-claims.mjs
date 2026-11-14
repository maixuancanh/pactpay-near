import {providers} from "near-api-js";
import {readFile,writeFile,rename} from "node:fs/promises";

const file = process.argv[2] || "docs/near/testnet-smoke.json";
const report = JSON.parse(await readFile(file,"utf8"));
const watch = process.argv.includes("--watch");
if (report.network !== "testnet" || !/^escrow\.pactpay-[a-f0-9]{8}\.testnet$/.test(report.escrow))
  throw Error("Expected a PactPay testnet transaction report.");
const provider = new providers.JsonRpcProvider({url:"https://test.rpc.fastnear.com"});
const path = ".near-testnet/claim-reconciliation.json";

async function scan() {
  const entries=[];
  for (const attempt of report.transactions.filter(tx=>tx.method==="claim")) {
    try {
      const result=await provider.txStatusReceipts(attempt.hash,attempt.signer,"FINAL");
      const tx=result.transaction;
      const call=tx.actions[0]?.FunctionCall;
      if(tx.hash!==attempt.hash || tx.signer_id!==attempt.signer || tx.receiver_id!==report.escrow ||
        tx.actions.length!==1 || call?.method_name!=="claim") throw Error("Transaction does not match expected claim.");
      const args=JSON.parse(Buffer.from(call.args,"base64").toString());
      const booking=await provider.callFunction(report.escrow,"get_booking",{id:args.id},{finality:"final"});
      const position=booking?.positions?.[args.index];
      const slot=args.refund?0:1;
      const state=position?.claims?.[slot];
      const value=result.status.SuccessValue;
      const callback=value===undefined?undefined:Buffer.from(value,"base64").toString();
      const status=state==="Paid"?"paid":state==="Unclaimed"&&callback==="false"?"retry-available":"review-required";
      entries.push({hash:attempt.hash,booking:args.id,position:args.index,role:args.refund?"buyer":"merchant",
        status,callback:callback??null,contractStatus:state??null,receipts:result.receipts_outcome.map(r=>({
          id:r.id,executor:r.outcome.executor_id,failed:typeof r.outcome.status==="object"&&"Failure" in r.outcome.status,
        }))});
    } catch(error) { entries.push({hash:attempt.hash,status:"review-required",error:String(error.message).slice(0,160)}); }
  }
  const snapshot={network:"testnet",escrow:report.escrow,checkedAt:new Date().toISOString(),entries};
  await writeFile(path+".tmp",JSON.stringify(snapshot,null,2)+"\n");
  await rename(path+".tmp",path);
  console.log(entries.map(({hash,status})=>({hash,status})));
  if(entries.some(entry=>entry.status==="review-required")) process.exitCode=1;
}
do {
  await scan();
  if(watch) await new Promise(resolve=>setTimeout(resolve,30000));
} while(watch);
