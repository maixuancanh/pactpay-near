import test from "node:test";
import assert from "node:assert/strict";
import {summarizeCost} from "./case-cost.mjs";

const result = () => ({final_execution_status:"FINAL",transaction:{hash:"tx",signer_id:"buyer.testnet",receiver_id:"escrow.testnet"},
  transaction_outcome:{id:"tx",outcome:{gas_burnt:10,tokens_burnt:"100"}},
  receipts_outcome:[{id:"receipt",outcome:{gas_burnt:20,tokens_burnt:"200"}}]});
test("cost counts transaction and receipt burn exactly once, excluding attached deposit",()=>{
  const tx=result(); tx.transaction.actions=[{FunctionCall:{deposit:"999999"}}];
  assert.deepEqual(summarizeCost(tx,{hash:"tx",signer:"buyer.testnet"},"escrow.testnet"),{gasBurnt:"30",tokensBurntYoctoNEAR:"300"});
});
test("cost refuses mismatched transaction, nonfinal data, missing receipts and duplicate outcomes",()=>{
  for(const change of [r=>r.transaction.receiver_id="wrong.testnet",r=>r.final_execution_status="EXECUTED",
    r=>delete r.receipts_outcome,r=>r.receipts_outcome.push(r.receipts_outcome[0]),r=>r.receipts_outcome[0].outcome.gas_burnt=-1]){
    const r=result(); change(r); assert.throws(()=>summarizeCost(r,{hash:"tx",signer:"buyer.testnet"},"escrow.testnet"));
  }
});
