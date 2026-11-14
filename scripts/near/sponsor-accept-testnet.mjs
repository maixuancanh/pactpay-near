import assert from "node:assert/strict";
import {readFile,writeFile} from "node:fs/promises";
import {Account,KeyPairSigner,providers,transactions} from "near-api-js";
import {actionCreators} from "@near-js/transactions";
const report=JSON.parse(await readFile("docs/near/testnet-smoke.json"));
const merchantKey=JSON.parse(await readFile(".near-testnet/deploy-key.json"));
const buyerKey=JSON.parse(await readFile(".near-testnet/"+report.buyers[0]+".json"));
const escrow=report.escrow;
assert.equal(escrow,"escrow."+merchantKey.accountId);
assert.match(escrow,/^escrow\.pactpay-[a-f0-9]{8}\.testnet$/);
const rpc=new providers.JsonRpcProvider({url:"https://test.rpc.fastnear.com"});
const user=key=>new Account(key.accountId,rpc,KeyPairSigner.fromSecretKey(key.secretKey));
const merchant=user(merchantKey),buyer=user(buyerKey);
const block=await rpc.block({finality:"final"});
const now=Number(BigInt(block.header.timestamp_nanosec)/1000000000n);
const terms="f".repeat(64);
const created=await merchant.functionCall({contractId:escrow,methodName:"create_booking",
args:{terms_commitment:terms,fund_until:String(now+600),service_end:String(now+900),shares:[{buyer:buyer.accountId,amount:"1"}]},
gas:30_000_000_000_000n,attachedDeposit:15_000_000_000_000_000_000_000n});
const id=JSON.parse(Buffer.from(created.status.SuccessValue,"base64"));
const delegate=await buyer.signedDelegate({receiverId:escrow,blockHeightTtl:50,
actions:[transactions.functionCall("accept",{id,index:0,terms_commitment:terms},15_000_000_000_000n,0n)]});
const result=await merchant.signAndSendTransaction({receiverId:buyer.accountId,
actions:[actionCreators.signedDelegate(delegate)],waitUntil:"FINAL",throwOnFailure:true});
const booking=await rpc.callFunction(escrow,"get_booking",{id},{finality:"final"});
assert.equal(booking.positions[0].accepted,true);
const evidence={network:"testnet",escrow,id,relayer:merchant.accountId,buyer:buyer.accountId,hash:result.transaction.hash,accepted:true};
await writeFile("docs/near/testnet-relayer.json",JSON.stringify(evidence,null,2));
console.log(evidence);
