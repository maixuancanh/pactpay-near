import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";
import {resolve} from "node:path";
import {fileURLToPath} from "node:url";
import {Account,KeyPairSigner,providers,transactions} from "near-api-js";

const base58=/^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const decode=call=>JSON.parse(Buffer.from(call.args,"base64"));
function event(outcome, standard, name) {
  return (outcome.logs ?? []).filter(log=>log.startsWith("EVENT_JSON:"))
    .map(log=>JSON.parse(log.slice(11))).filter(log=>log.standard===standard && log.event===name)
    .flatMap(log=>log.data);
}

export async function inspectClaim(rpc,{escrow,token,hash,sender}) {
  assert.match(hash,base58);
  const tx=await rpc.txStatusReceipts(hash,sender,"FINAL");
  assert.equal(tx.final_execution_status,"FINAL");
  assert.equal(tx.transaction.hash,hash);
  assert.equal(tx.transaction.signer_id,sender);
  assert.equal(tx.transaction.receiver_id,escrow);
  const [action]=tx.transaction.actions;
  assert.equal(tx.transaction.actions.length,1);
  assert.equal(action?.FunctionCall?.method_name,"claim_v2");
  const {claim_id}=decode(action.FunctionCall);
  const outcomes=new Map(tx.receipts_outcome.map(item=>[item.id,item.outcome]));
  const receipt=(ref,predecessor,receiver,method)=>{
    assert.match(ref,base58);
    const matches=tx.receipts.filter(item=>item.receipt_id===ref && item.predecessor_id===predecessor && item.receiver_id===receiver);
    assert.equal(matches.length,1,"Expected one matching receipt");
    const actions=matches[0].receipt.Action?.actions;
    assert.equal(actions?.length,1);
    assert.equal(actions[0]?.FunctionCall?.method_name,method);
    return decode(actions[0].FunctionCall);
  };
  const first=tx.transaction_outcome.outcome.status.SuccessReceiptId;
  assert.equal(receipt(first,sender,escrow,"claim_v2").claim_id,claim_id);
  const initial=outcomes.get(first);
  assert.equal(initial?.executor_id,escrow);
  const pending=event(initial,"pactpay","claim_pending");
  assert.equal(pending.length,1);
  const claim=pending[0];
  assert.equal(claim.claim_id,claim_id);
  assert.equal(claim.token,token);
  assert.equal(claim.recipient,sender);
  assert.equal(claim.status,"Pending");
  const callback=initial.status.SuccessReceiptId;
  const callbackArgs=receipt(callback,escrow,escrow,"finish_claim_v2");
  assert.equal(callbackArgs.claim_id,claim_id);
  assert.equal(callbackArgs.attempt_nonce,claim.attempt_nonce);
  const transfers=tx.receipts.filter(item=>initial.receipt_ids.includes(item.receipt_id) &&
    item.predecessor_id===escrow && item.receiver_id===token);
  assert.equal(transfers.length,1,"Expected one token transfer child");
  const transfer_receipt=transfers[0].receipt_id;
  const transfer=receipt(transfer_receipt,escrow,token,"ft_transfer");
  assert.equal(transfer.receiver_id,sender);
  assert.equal(transfer.amount,claim.amount);
  const execution=outcomes.get(transfer_receipt);
  assert.equal(execution?.executor_id,token);
  const transferred=typeof execution.status.SuccessValue==="string";
  const failed=Boolean(execution.status.Failure);
  assert.notEqual(transferred,failed,"Token transfer outcome is ambiguous");
  const movement=event(execution,"nep141","ft_transfer");
  assert.equal(movement.length,transferred ? 1 : 0,"Unexpected token transfer event");
  if(transferred){
    assert.equal(movement[0].old_owner_id,escrow);
    assert.equal(movement[0].new_owner_id,sender);
    assert.equal(movement[0].amount,claim.amount);
  }
  const callbackOutcome=outcomes.get(callback);
  assert.equal(callbackOutcome?.executor_id,escrow);
  const id=Number(claim.booking), index=Number(claim.position);
  assert.ok(Number.isSafeInteger(id) && id>=0 && Number.isInteger(index) && index>=0 && index<32);
  const records=await rpc.callFunction(escrow,"get_claims",{id,index},{finality:"final"});
  const current=records.find(item=>item.claim_id===claim_id);
  assert.equal(current?.attempt_nonce,claim.attempt_nonce);
  assert.equal(current.recipient,sender);
  assert.equal(current.amount,claim.amount);
  assert.equal(current.agreement_version,claim.version);
  return {claim_id,attempt_nonce:claim.attempt_nonce,transfer_receipt,id,index,amount:claim.amount,
    status:current.status,transferred,callbackFailed:Boolean(callbackOutcome.status.Failure),
    eligible:current.status==="Pending" && Boolean(callbackOutcome.status.Failure)};
}

async function main() {
  const [hash,sender,flag]=process.argv.slice(2);
  assert.ok(hash && sender && (flag===undefined || flag==="--apply"),"Usage: reconcile-resolution-v2.mjs TX SIGNER [--apply]");
  const {escrow,token}=JSON.parse(await readFile("docs/near/testnet-resolution-v2-deployment.json","utf8"));
  assert.match(escrow,/^escrow-v2\.pactpay-[a-f0-9]{8}\.testnet$/);
  const rpc=new providers.JsonRpcProvider({url:"https://test.rpc.fastnear.com"});
  const verified=await inspectClaim(rpc,{escrow,token,hash,sender});
  console.log(JSON.stringify(verified));
  if(flag!=="--apply")return;
  assert.ok(verified.eligible,"Only a current Pending attempt with a finalized transfer outcome and failed callback can be reconciled.");
  const key=JSON.parse(await readFile(".near-testnet/deploy-key.json","utf8"));
  assert.equal(escrow,"escrow-v2."+key.accountId);
  const operator=new Account(escrow,rpc,KeyPairSigner.fromSecretKey(key.secretKey));
  const {claim_id,attempt_nonce,transfer_receipt}=verified;
  const method=verified.transferred ? "reconcile_paid_claim_v2" : "reconcile_failed_claim_v2";
  const result=await operator.signAndSendTransaction({receiverId:escrow,waitUntil:"FINAL",throwOnFailure:true,
    actions:[transactions.functionCall(method,{claim_id,attempt_nonce,transfer_receipt},30_000_000_000_000n,0n)]});
  assert.equal(typeof result.status?.SuccessValue,"string");
  const next=await inspectClaim(rpc,{escrow,token,hash,sender});
  assert.equal(next.status,verified.transferred ? "Paid" : "Available");
  console.log("Reconciled on testnet:",result.transaction.hash);
}
if (process.argv[1] && resolve(process.argv[1])===fileURLToPath(import.meta.url)) await main();
