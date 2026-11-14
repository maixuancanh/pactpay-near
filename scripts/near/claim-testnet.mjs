import {readFile} from "node:fs/promises";
import {Account, KeyPairSigner, providers, transactions} from "near-api-js";

const [idText,indexText,role,keyFile,confirm] = process.argv.slice(2);
if (!/^\d+$/.test(idText ?? "") || !/^\d+$/.test(indexText ?? "") ||
    !["buyer","merchant"].includes(role) || !keyFile || !Number.isSafeInteger(Number(idText)) || Number(indexText)>31)
  throw new Error("Usage: node scripts/near/claim-testnet.mjs BOOKING POSITION buyer|merchant LOCAL_KEY_FILE [--send]");
const id=Number(idText), index=Number(indexText), refund=role==="buyer";
const escrow="escrow.pactpay-530c506b.testnet";
const key=JSON.parse(await readFile(keyFile,"utf8"));
const rpc=new providers.JsonRpcProvider({url:"https://test.rpc.fastnear.com"});
const read=()=>rpc.callFunction(escrow,"get_booking",{id},{finality:"final"});
const booking=await read();
const position=booking?.positions?.[index];
const recipient=refund ? position?.buyer : booking?.merchant;
const slot=refund ? 0 : 1;
if (!position || key.accountId!==recipient) throw new Error("This key does not belong to the recipient.");
const amount=position.allocation?.[slot], status=position.claims[slot];
console.log({escrow,id,index,recipient,amount,status});
if (confirm === "--send") {
  if (status!=="Unclaimed" || !amount || BigInt(amount)===0n) throw new Error("No available claim. Reconcile an in-flight claim before retrying.");
  const sender=new Account(recipient,rpc,KeyPairSigner.fromSecretKey(key.secretKey));
  const result=await sender.signAndSendTransaction({receiverId:escrow,waitUntil:"FINAL",throwOnFailure:true,
    actions:[transactions.functionCall("claim",{id,index,refund},100_000_000_000_000n,0n)]});
  console.log("Transaction:",result.transaction.hash);
  const value=result.status.SuccessValue;
  const state=(await read()).positions[index].claims[slot];
  console.log("Claim state:",state);
  if (!value || Buffer.from(value,"base64").toString()!=="true" || state!=="Paid") process.exitCode=1;
}
