import assert from "node:assert/strict";
import {createHash} from "node:crypto";
import {readFile,writeFile} from "node:fs/promises";
import {Account,KeyPairSigner,providers,transactions} from "near-api-js";

const manifest=JSON.parse(await readFile("docs/near/testnet-resolution-v2-failed-transfer-upgrade.json"));
const key=JSON.parse(await readFile(".near-testnet/deploy-key.json"));
const {escrow,token}=manifest;
assert.match(key.accountId,/^pactpay-[0-9a-f]{8}\.testnet$/);
assert.equal(escrow,"escrow-v2."+key.accountId);
assert.equal(token,"token."+key.accountId);
const rpc=new providers.JsonRpcProvider({url:"https://test.rpc.fastnear.com"});
const sha=bytes=>createHash("sha256").update(bytes).digest("hex");
const code=account_id=>rpc.query({request_type:"view_code",account_id,finality:"final"});
const view=(id,method,args={})=>rpc.callFunction(id,method,args,{finality:"final"});
const tokenWasm=await readFile("contracts/near/demo-token/target/wasm32-unknown-unknown/release/pactpay_demo_token.wasm");
const escrowWasm=await readFile("contracts/near-v2/target/wasm32-unknown-unknown/release/pactpay_escrow_v2.wasm");
assert.ok(!escrowWasm.includes("Injected Sandbox callback failure"));
const before=await code(escrow);
assert.ok([manifest.sha256,sha(escrowWasm)].includes(sha(Buffer.from(before.code_base64,"base64"))));
const snapshot=()=>Promise.all([view(escrow,"get_booking",{id:0}),view(escrow,"get_claims",{id:0,index:0}),view(token,"ft_total_supply")]);
const initial=await snapshot();
assert.ok(initial[0]);
const evidence={network:"testnet",escrow,token,transactions:{}};
for(const [id,wasm] of [[token,tokenWasm],[escrow,escrowWasm]]){
  const state=await rpc.query({request_type:"view_account",account_id:id,finality:"final"});
  const old=await code(id);
  const storage=BigInt(Math.max(0,wasm.length-Buffer.from(old.code_base64,"base64").length)+2048)*10n**19n;
  console.log(JSON.stringify({id,wasmBytes:wasm.length,additionalStorageBudget:String(storage),balance:state.amount}));
  if(!process.argv.includes("--send"))continue;
  assert.ok(BigInt(state.amount)-BigInt(state.storage_usage)*10n**19n>storage,"Insufficient storage headroom");
  const signer=new Account(id,rpc,KeyPairSigner.fromSecretKey(key.secretKey));
  if(sha(Buffer.from(old.code_base64,"base64"))!==sha(wasm)){
    const tx=await signer.signAndSendTransaction({receiverId:id,actions:[transactions.deployContract(wasm)],waitUntil:"FINAL",throwOnFailure:true});
    evidence.transactions[id]=tx.transaction.hash;
  }
  assert.equal(sha(Buffer.from((await code(id)).code_base64,"base64")),sha(wasm));
}
if(process.argv.includes("--send")){
  assert.deepEqual(await snapshot(),initial);
  if(!await view(token,"payout_enabled",{escrow})){
    const signer=new Account(token,rpc,KeyPairSigner.fromSecretKey(key.secretKey));
    const tx=await signer.signAndSendTransaction({receiverId:token,actions:[transactions.functionCall("enable_payout_escrow",{escrow},30_000_000_000_000n,0n)],waitUntil:"FINAL",throwOnFailure:true});
    evidence.transactions.enable=tx.transaction.hash;
  }
  assert.equal(await view(token,"payout_enabled",{escrow}),true);
  await writeFile("docs/near/testnet-resolution-v2-retryable.json",JSON.stringify({...evidence,booking0Preserved:true},null,2)+"\n");
}
