import assert from "node:assert/strict";
import {readFile, writeFile} from "node:fs/promises";
import {randomBytes, createHash} from "node:crypto";
import {Account, KeyPair, KeyPairSigner, providers, transactions} from "near-api-js";

const dir = new URL("../../.near-testnet/", import.meta.url);
const root = JSON.parse(await readFile(new URL("deploy-key.json", dir)));
assert.match(root.accountId, /^pactpay-[0-9a-f]{8}\.testnet$/);
const rpc = new providers.JsonRpcProvider({url:"https://test.rpc.fastnear.com"});
const merchant = new Account(root.accountId, rpc, KeyPairSigner.fromSecretKey(root.secretKey));
const escrow = "escrow." + root.accountId;
const token = "token." + root.accountId;
const evidence = {network:"testnet", escrow, token, merchant:root.accountId, transactions:[]};
const report = new URL("../../docs/near/testnet-smoke.json", import.meta.url);
async function save() { await writeFile(report, JSON.stringify(evidence,null,2)+"\n"); }
async function send(who, receiverId, method, args, deposit=0n) {
  const result = await who.signAndSendTransaction({receiverId, waitUntil:"FINAL", throwOnFailure:true,
    actions:[transactions.functionCall(method,args,100_000_000_000_000n,deposit)]});
  evidence.transactions.push({method, hash:result.transaction.hash, signer:who.accountId, receiver:receiverId});
  await save();
  const value = result.status.SuccessValue;
  return value ? JSON.parse(Buffer.from(value,"base64").toString()) : undefined;
}
const view = (accountId, method, args={}) => rpc.callFunction(accountId, method, args, {finality:"final"});
const balance = account_id => view(token,"ft_balance_of",{account_id});
const now = async () => Number(BigInt((await rpc.block({finality:"final"})).header.timestamp_nanosec)/1_000_000_000n);
const suffix = randomBytes(2).toString("hex");
const buyers = [];
for (let i=0;i<2;i++) {
  const id = "b"+i+suffix+"."+root.accountId;
  const key = KeyPair.fromRandom("ed25519");
  await writeFile(new URL(id+".json", dir), JSON.stringify({accountId:id, secretKey:key.toString()}), {flag:"wx",mode:0o600});
  const tx = await merchant.signAndSendTransaction({receiverId:id, waitUntil:"FINAL", throwOnFailure:true,
    actions:[transactions.createAccount(),transactions.transfer(200_000_000_000_000_000_000_000n),
      transactions.addKey(key.getPublicKey(),transactions.fullAccessKey())]});
  evidence.transactions.push({method:"create_buyer", hash:tx.transaction.hash, signer:merchant.accountId, receiver:id});
  await save();
  buyers.push(new Account(id,rpc,new KeyPairSigner(key)));
  await send(merchant,token,"storage_deposit",{account_id:id,registration_only:true},1250000000000000000000n);
  await send(merchant,token,"ft_transfer",{receiver_id:id,amount:i===0?"80":"20"},1n);
}
evidence.buyers = buyers.map(b=>b.accountId);
const terms = "Synthetic testnet workshop terms. Confirmation authorizes payout.\n\nReference: "+randomBytes(32).toString("hex");
const commitment = createHash("sha256").update(terms).digest("hex");
const time = await now();
const id = await send(merchant,escrow,"create_booking",{terms_commitment:commitment, fund_until:String(time+60),
  service_end:String(time+75),shares:buyers.map((b,i)=>({buyer:b.accountId,amount:i===0?"80":"20"}))},
  20_000_000_000_000_000_000_000n);
evidence.booking = id;
evidence.terms = terms;
await save();
console.log("Created testnet booking",id);
for (const [index,b] of buyers.entries()) {
  await send(b,escrow,"accept",{id,index,terms_commitment:commitment});
  assert.equal(await send(b,token,"ft_transfer_call",{receiver_id:escrow,amount:index===0?"80":"20",
    msg:JSON.stringify({booking:id,position:index})},1n),index===0?"80":"20");
}
const starting = BigInt(await balance(merchant.accountId));
await send(merchant,escrow,"capture",{id});
console.log("Captured 100 demo tokens; waiting for service end");
while (await now() < time+75) await new Promise(resolve=>setTimeout(resolve,4000));
const disputed = {id,index:1};
await send(buyers[1],escrow,"open_dispute",disputed);
await send(buyers[0],escrow,"confirm_completion",{id,index:0});
assert.equal(await send(merchant,escrow,"claim",{id,index:0,refund:false}),true);
const booking = await view(escrow,"get_booking",{id});
assert.equal(booking.positions[0].claims[1],"Paid");
assert.equal(booking.positions[1].allocation,null);
await send(buyers[1],escrow,"revise_evidence",{...disputed,commitment:randomBytes(32).toString("hex")});
const proposal = {...disputed, refund:"8",payout:"12",expires:booking.positions[1].dispute_until,
  evidence_revision:"1",expected_proposal_version:"0"};
await send(buyers[1],escrow,"approve_resolution",proposal);
await send(merchant,escrow,"approve_resolution",{...proposal,expected_proposal_version:"1"});
assert.equal(await send(buyers[1],escrow,"claim",{...disputed,refund:true}),true);
assert.equal(await send(merchant,escrow,"claim",{...disputed,refund:false}),true);
const final = await view(escrow,"get_booking",{id});
assert.deepEqual(final.positions[1].allocation,["8","12"]);
assert.deepEqual(final.positions[1].claims,["Paid","Paid"]);
assert.equal(BigInt(await balance(merchant.accountId))-starting,92n);
assert.equal(await balance(buyers[1].accountId),"8");
evidence.result = {merchantIncrease:"92",buyerRefund:"8",finalBooking:final};
await save();
console.log("Testnet settlement verified",id,"merchant +92, refund 8");
