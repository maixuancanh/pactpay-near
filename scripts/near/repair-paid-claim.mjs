import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";
import {Account,KeyPairSigner,providers,transactions} from "near-api-js";

const [hash,sender,apply]=process.argv.slice(2);
assert.match(hash||"",/^[1-9A-HJ-NP-Za-km-z]{32,44}$/);
const {escrow,token}=JSON.parse(await readFile("docs/near/testnet-deployment.json"));
assert.match(escrow,/^escrow\.pactpay-[a-f0-9]{8}\.testnet$/);
const rpc=new providers.JsonRpcProvider({url:"https://test.rpc.fastnear.com"});
const tx=await rpc.txStatusReceipts(hash,sender,"FINAL");
assert.equal(tx.final_execution_status,"FINAL");
assert.equal(tx.transaction.hash,hash);
assert.equal(tx.transaction.signer_id,sender);
assert.equal(tx.transaction.receiver_id,escrow);
const action=tx.transaction.actions[0]?.FunctionCall;
assert.equal(tx.transaction.actions.length,1);
assert.equal(action?.method_name,"claim");
const decode=action=>JSON.parse(Buffer.from(action.args,"base64"));
const {id,index,refund}=decode(action);
const booking=await rpc.callFunction(escrow,"get_booking",{id},{finality:"final"});
const pos=booking.positions[index];
const slot=refund?0:1;
const recipient=refund?pos.buyer:booking.merchant;
const amount=pos.allocation[slot];
assert.equal(sender,recipient);
const valid=tx.receipts.filter(receipt=>{
  const a=receipt.receipt.Action?.actions?.[0]?.FunctionCall;
  if(receipt.predecessor_id!==escrow || receipt.receiver_id!==token || a?.method_name!=="ft_transfer")return false;
  const args=decode(a);
  const result=tx.receipts_outcome.find(r=>r.id===receipt.receipt_id);
  return args.receiver_id===recipient&&args.amount===amount&&typeof result?.outcome.status?.SuccessValue==="string";
});
assert.equal(valid.length,1,"Expected exactly one successful matching token transfer");
const transfer_receipt=valid[0].receipt_id;
console.log({id,index,refund,recipient,amount,transfer_receipt,claim:pos.claims[slot]});
if(apply==="--apply"){
  assert.equal(pos.claims[slot],"Pending");
  const key=JSON.parse(await readFile(".near-testnet/deploy-key.json"));
  assert.equal(escrow,"escrow."+key.accountId);
  const account=new Account(escrow,rpc,KeyPairSigner.fromSecretKey(key.secretKey));
  const result=await account.signAndSendTransaction({receiverId:escrow,waitUntil:"FINAL",throwOnFailure:true,
    actions:[transactions.functionCall("record_reconciled_payout",{id,index,refund,transfer_receipt},30_000_000_000_000n,0n)]});
  console.log("Reconciliation transaction:",result.transaction.hash);
}
