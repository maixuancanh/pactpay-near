import assert from "node:assert/strict";
import {createHash} from "node:crypto";
import {readFile,writeFile} from "node:fs/promises";
import {Account,KeyPairSigner,providers,transactions} from "near-api-js";

const rpc=new providers.JsonRpcProvider({url:"https://test.rpc.fastnear.com"});
const manifest=JSON.parse(await readFile("docs/near/testnet-resolution-v2-deployment.json","utf8"));
const key=JSON.parse(await readFile(".near-testnet/deploy-key.json","utf8"));
const {escrow,token}=manifest;
assert.match(escrow,/^escrow-v2\.pactpay-[a-f0-9]{8}\.testnet$/);
assert.equal(escrow,"escrow-v2."+key.accountId);
const wasm=await readFile("contracts/near-v2/target/wasm32-unknown-unknown/release/pactpay_escrow_v2.wasm");
assert.ok(!wasm.includes("Injected Sandbox callback failure"),"Fault injection leaked into release");
const hash=bytes=>createHash("sha256").update(bytes).digest("hex");
const sha256=hash(wasm);
const view=(method,args={})=>rpc.callFunction(escrow,method,args,{finality:"final"});
const code=()=>rpc.query({request_type:"view_code",account_id:escrow,finality:"final"});
const beforeCode=await code();
const beforeHash=hash(Buffer.from(beforeCode.code_base64,"base64"));
const firstRecoveryHash="532069ce70234ae58e25927e8d77edb41ae11ce62cacad113dbd8017ca6122de";
assert.ok([manifest.sha256,firstRecoveryHash].includes(beforeHash),"Unexpected contract code; inspect before upgrading.");
const snapshot=()=>Promise.all([
  view("get_token"),view("contract_version"),view("get_booking",{id:0}),
  view("get_agreement",{id:0,index:0}),view("get_claims",{id:0,index:0}),
  view("get_position_ledger",{id:0,index:0}),
]);
const before=await snapshot();
assert.equal(before[0],token);
assert.equal(before[1],2);
assert.ok(before[2]);
console.log(JSON.stringify({escrow,beforeHash,sha256,wasmBytes:wasm.length}));
assert.notEqual(beforeHash,sha256,"Release is already deployed");
if(process.argv.includes("--send")){
  const signer=new Account(escrow,rpc,KeyPairSigner.fromSecretKey(key.secretKey));
  const result=await signer.signAndSendTransaction({receiverId:escrow,waitUntil:"FINAL",throwOnFailure:true,
    actions:[transactions.deployContract(wasm)]});
  const after=await code();
  assert.equal(hash(Buffer.from(after.code_base64,"base64")),sha256);
  assert.deepEqual(await snapshot(),before);
  const evidence={network:"testnet",escrow,token,beforeHash,sha256,codeHash:after.hash,
    transaction:{hash:result.transaction.hash,signer:escrow},booking0Preserved:true};
  await writeFile(beforeHash===firstRecoveryHash ? "docs/near/testnet-resolution-v2-failed-transfer-upgrade.json" :
    "docs/near/testnet-resolution-v2-recovery-upgrade.json",JSON.stringify(evidence,null,2)+"\n");
  console.log(JSON.stringify(evidence));
}
