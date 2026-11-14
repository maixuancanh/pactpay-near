import assert from "node:assert/strict";
import {readFile, writeFile} from "node:fs/promises";
import {createHash,randomBytes} from "node:crypto";
import {setTimeout as delay} from "node:timers/promises";
import {Account,KeyPairSigner,providers,transactions} from "near-api-js";
import {agreementDigest} from "../../src/near/agreements/canonical.ts";

if (!process.argv.includes("--send")) throw new Error("Pass --send to create a synthetic PDEMO testnet booking.");
const deployment=JSON.parse(await readFile("docs/near/testnet-resolution-v2-deployment.json","utf8"));
const {escrow,token}=deployment;
assert.match(escrow,/^escrow-v2\.pactpay-[0-9a-f]{8}\.testnet$/);
const rpc=new providers.JsonRpcProvider({url:"https://test.rpc.fastnear.com"});
const view=(method,args={},receiver=escrow)=>rpc.callFunction(receiver,method,args,{finality:"final"});
async function load(file) {
  const record=JSON.parse(await readFile(".near-testnet/"+file,"utf8"));
  assert.match(record.accountId,/\.testnet$/);
  return new Account(record.accountId,rpc,KeyPairSigner.fromSecretKey(record.secretKey));
}
const merchant=await load("deploy-key.json");
const buyer=await load("b05bfd.pactpay-530c506b.testnet.json");
const refs={};
const retryable=process.argv.includes("--retryable");
const output=retryable ? "docs/near/testnet-resolution-v2-retryable-smoke.json" : "docs/near/testnet-resolution-v2-smoke.json";
let id;
async function call(name,signer,method,args,deposit=0n,receiver=escrow) {
  const result=await signer.signAndSendTransaction({
    receiverId:receiver,waitUntil:"FINAL",throwOnFailure:true,
    actions:[transactions.functionCall(method,args,100_000_000_000_000n,deposit)],
  });
  assert.equal(typeof result.status?.SuccessValue,"string",JSON.stringify(result.status));
  refs[name]={hash:result.transaction.hash,signer:signer.accountId};
  await writeFile(output,JSON.stringify({escrow,token,id,transactions:refs},null,2)+"\n");
  return Buffer.from(result.status.SuccessValue,"base64").toString();
}
const time=async()=>Number(BigInt((await rpc.block({finality:"final"})).header.timestamp_nanosec)/1_000_000_000n);
const walletBalance=address=>view("ft_balance_of",{account_id:address},token);
for(const signer of [buyer,merchant]) {
  if(!await view("storage_balance_of",{account_id:signer.accountId},token)) {
    const {min}=await view("storage_balance_bounds",{},token);
    await call("register_"+signer.accountId,merchant,"storage_deposit",{account_id:signer.accountId,registration_only:true},BigInt(min),token);
  }
}
if(BigInt(await walletBalance(buyer.accountId))<20n) await call("seed",merchant,"ft_transfer",{receiver_id:buyer.accountId,amount:"20"},1n,token);
const now=await time(), end=now+95;
const hash=value=>createHash("sha256").update(value).digest("hex");
const terms=hash("Synthetic workshop smoke "+randomBytes(32).toString("hex"));
const deposit=BigInt(await view("booking_storage_deposit",{positions:1}));
id=Number(await call("create",merchant,"create_booking",{terms_commitment:terms,fund_until:String(now+75),
  service_end:String(end),shares:[{buyer:buyer.accountId,amount:"20"}]},deposit));
assert.ok(Number.isSafeInteger(id));
const base={id,index:0};
await call("accept",buyer,"accept",{...base,terms_commitment:terms});
assert.equal(JSON.parse(await call("contribute",buyer,"ft_transfer_call",{receiver_id:escrow,amount:"20",
  msg:JSON.stringify({booking:id,position:0})},1n,token)),"20");
await call("capture",merchant,"capture",{id});
console.log("V2 funded booking",id);
while(await time()<end) await delay(5000);
await call("dispute",buyer,"open_dispute",base);
const evidenceRoot=hash("Synthetic smoke evidence snapshot "+id);
await call("commit",merchant,"revise_evidence",{...base,commitment:evidenceRoot});
const current=await time();
const proposal={schema:"pactpay.resolution.v2",network:"testnet",escrow,booking:String(id),position:"0",version:"1",
  buyer:buyer.accountId,merchant:merchant.accountId,token,termsCommitment:terms,evidenceRoot,
  privateTermsCommitment:hash("Synthetic smoke terms"),assessmentDigest:null,
  immediateBuyer:"0",immediateMerchant:"12",retained:"8",successBuyer:"0",successMerchant:"8",
  fallbackBuyer:"5",fallbackMerchant:"3",acceptBy:String(current+180),deliverBy:String(current+360),
  reviewUntil:String(current+540),salt:randomBytes(32).toString("hex")};
await call("proposal",merchant,"propose_agreement",{...base,proposal});
const digest=await agreementDigest(proposal);
assert.equal((await view("get_agreement",base)).digest,digest);
await call("approve",buyer,"approve_agreement",{...base,version:"1",digest});
const balanceBefore=BigInt(await walletBalance(merchant.accountId));
async function claim(amount) {
  const record=(await view("get_claims",base)).find(entry=>entry.amount===amount && entry.status==="Available");
  assert.ok(record);
assert.equal(await call("claim_"+amount,merchant,retryable ? "claim_retryable_v2" : "claim_v2",{claim_id:record.claim_id}),"true");
}
await claim("12");
const interim=await view("get_position_ledger",base);
assert.equal(interim.retained,"8");
assert.equal(interim.paid,"12");
assert.equal(BigInt(await walletBalance(merchant.accountId))-balanceBefore,12n);
await call("submit",merchant,"submit_completion",{...base,version:"1",evidence_root:hash("Synthetic completion")});
await call("confirm",buyer,"confirm_agreement_completion",{...base,version:"1",digest});
await claim("8");
const final=await view("get_position_ledger",base);
assert.equal(final.retained,"0");
assert.equal(final.paid,"20");
assert.equal(BigInt(await walletBalance(merchant.accountId))-balanceBefore,20n);
await writeFile(output,JSON.stringify({network:"testnet",escrow,token,id,synthetic:true,signing:"script",interim,final,transactions:refs},null,2)+"\n");
console.log(JSON.stringify({id,interim,final,transactions:refs}));
