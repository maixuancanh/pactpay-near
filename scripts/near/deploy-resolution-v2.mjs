import {readFile, writeFile} from "node:fs/promises";
import {createHash} from "node:crypto";
import {Account, KeyPair, KeyPairSigner, transactions} from "near-api-js";
import {JsonRpcProvider} from "@near-js/providers";

const root = new URL("../../", import.meta.url);
const wasm = await readFile(new URL("contracts/near-v2/target/wasm32-unknown-unknown/release/pactpay_escrow_v2.wasm", root));
const key = JSON.parse(await readFile(new URL(".near-testnet/deploy-key.json",root),"utf8"));
if (!/^pactpay-[0-9a-f]{8}\.testnet$/.test(key.accountId)) throw new Error("Expected an isolated PactPay testnet deployer.");
const provider = new JsonRpcProvider({url:"https://test.rpc.fastnear.com"});
const escrow = `escrow-v2.${key.accountId}`;
const token = `token.${key.accountId}`;
const account = new Account(key.accountId,provider,KeyPairSigner.fromSecretKey(key.secretKey));
const balance = async accountId => provider.query({request_type:"view_account",account_id:accountId,finality:"final"});
const sha256 = createHash("sha256").update(wasm).digest("hex");
const deposit = (BigInt(wasm.length)+8192n)*10n**19n + 10n**24n;
const view = (contractId,methodName,args={})=>account.viewFunction({contractId,methodName,args});
const existing = await balance(escrow).catch(error=>{
  if (error.type === "AccountDoesNotExist" || /UNKNOWN_ACCOUNT/i.test(String(error))) return null;
  throw error;
});
await view(token,"ft_metadata");
console.log(JSON.stringify({escrow,token,sha256,wasmBytes:wasm.length,deposit:String(deposit),existing:Boolean(existing),
  deployerBalance:(await balance(key.accountId)).amount}));
if (!process.argv.includes("--send")) process.exit(0);

const refs = {};
async function record(label, outcome) {
  refs[label] = {hash:outcome.transaction.hash,signer:outcome.transaction.signer_id};
  await writeFile(new URL("docs/near/testnet-resolution-v2-deployment.json",root),
    JSON.stringify({network:"testnet",escrow,token,sha256,transactions:refs},null,2)+"\n");
}
if (!existing) {
  await record("deploy",await account.signAndSendTransaction({
    receiverId:escrow, waitUntil:"FINAL", throwOnFailure:true,
    actions:[
      transactions.createAccount(),transactions.transfer(deposit),
      transactions.addKey(KeyPair.fromString(key.secretKey).getPublicKey(),transactions.fullAccessKey()),
      transactions.deployContract(wasm),
      transactions.functionCall("new",{token},30_000_000_000_000n,0n),
    ],
  }));
}
const current = await provider.query({request_type:"view_code",account_id:escrow,finality:"final"});
if (createHash("sha256").update(Buffer.from(current.code_base64,"base64")).digest("hex") !== sha256 ||
  await view(escrow,"contract_version") !== 2 || await view(escrow,"get_token") !== token) {
  throw new Error("V2 deployed code or configuration does not match.");
}
if (!await view(token,"storage_balance_of",{account_id:escrow})) {
  const {min} = await view(token,"storage_balance_bounds");
  await record("register",await account.functionCall({contractId:token,methodName:"storage_deposit",
    args:{account_id:escrow,registration_only:true},attachedDeposit:BigInt(min),gas:30_000_000_000_000n,
    waitUntil:"FINAL",throwOnFailure:true}));
}
console.log(JSON.stringify({escrow,token,codeHash:current.hash,registered:Boolean(await view(token,"storage_balance_of",{account_id:escrow}))}));
