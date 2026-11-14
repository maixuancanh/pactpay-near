import {createDecipheriv, createHash} from "node:crypto";
import {readFile} from "node:fs/promises";
import {providers} from "near-api-js";
import {isDeepStrictEqual} from "node:util";

if (!process.argv[2]) throw new Error("Pass the exported private case JSON file.");
const data=JSON.parse(await readFile(process.argv[2],"utf8"));
if(data.network!=="testnet" || data.escrow!=="escrow.pactpay-530c506b.testnet" ||
   !Number.isSafeInteger(data.booking) || data.booking<0 || !Number.isInteger(data.position) || data.position<0)
  throw new Error("Invalid PactPay testnet export.");
const {evidence}=data;
const digest=createHash("sha256").update(Buffer.from(evidence.iv,"base64"))
  .update(Buffer.from(evidence.ciphertext,"base64")).digest("hex");
if(digest!==evidence.id) throw new Error("Ciphertext does not match the evidence ID.");
if (evidence.excerptKey !== undefined) {
  const encrypted = Buffer.from(evidence.ciphertext,"base64");
  const decipher = createDecipheriv("aes-256-gcm",Buffer.from(evidence.excerptKey,"base64"),Buffer.from(evidence.iv,"base64"));
  decipher.setAuthTag(encrypted.subarray(-16));
  const plaintext = Buffer.concat([decipher.update(encrypted.subarray(0,-16)),decipher.final()]).toString("utf8");
  if (plaintext !== evidence.text) throw new Error("Readable evidence does not match the committed encrypted excerpt.");
}
const rpc=new providers.JsonRpcProvider({url:"https://test.rpc.fastnear.com"});
const booking=await rpc.callFunction(data.escrow,"get_booking",{id:data.booking},{finality:"final"});
if(booking?.positions?.[data.position]?.evidence_commitment!==digest)
  throw new Error("This ciphertext is not the current on-chain commitment for the position.");
if (Object.hasOwn(data,"onChainRemedy")) {
  const remedy = await rpc.callFunction(data.escrow,"get_remedy",
    {id:data.booking,index:data.position},{finality:"final"});
  const canonical = value => value === null ? null : Object.fromEntries(Object.entries(value).sort());
  if (!isDeepStrictEqual(canonical(remedy),canonical(data.onChainRemedy))) {
    throw new Error("The exported remedy differs from current finalized NEAR state.");
  }
  console.log("Remedy approval and completion snapshot matches finalized NEAR state.");
}

if (process.argv[3]) {
  const references = JSON.parse(await readFile(process.argv[3],"utf8"));
  const remedy = data.onChainRemedy;
  const current = booking.positions[data.position];
  if (!remedy?.completed || !Array.isArray(references) || references.length !== 3) {
    throw new Error("Provide the proposal, acceptance and completion receipts for a completed remedy.");
  }
  const methods = ["propose_remedy","accept_remedy","complete_remedy"];
  const signers = new Set([booking.merchant,current.buyer]);
  for (const [i,{hash,signer}] of references.entries()) {
    if (!signers.has(signer) || !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(hash)) throw new Error("Invalid receipt reference.");
    const receipt = await rpc.txStatusReceipts(hash,signer,"FINAL");
    const tx = receipt.transaction;
    const call = tx.actions[0]?.FunctionCall;
    if (receipt.final_execution_status !== "FINAL" || typeof receipt.status?.SuccessValue !== "string" ||
        tx.hash !== hash || tx.signer_id !== signer || tx.receiver_id !== data.escrow ||
        tx.actions.length !== 1 || call?.method_name !== methods[i]) {
      throw new Error("Unexpected remedy transaction.");
    }
    const args = JSON.parse(Buffer.from(call.args,"base64"));
    const expected = i === 0
      ? {refund:remedy.refund,payout:remedy.payout}
      : {revision:remedy.revision};
    if (args.id !== data.booking || args.index !== data.position || args.due !== remedy.due ||
        Object.entries(expected).some(([key,value])=>args[key]!==value)) {
      throw new Error("A receipt does not approve the exported remedy.");
    }
  }
  if (references[0].signer === references[1].signer || references[2].signer !== current.buyer) {
    throw new Error("Expected bilateral approval and buyer confirmation.");
  }
  console.log("Finalized receipts prove the proposal, the other party’s acceptance and the buyer’s completion.");
}
console.log(evidence.excerptKey
  ? "Ciphertext and readable text match the current finalized evidence commitment."
  : "Ciphertext matches the current finalized commitment. This older export has no excerpt key for verifying readable text.");
if (data.analysis?.proof) {
  const {version,request,response,signature,attestation} = data.analysis.proof;
  if (version !== 1 || signature?.kind !== "provider_tee" || typeof attestation?.nonce !== "string") {
    throw new Error("Unsupported AI proof.");
  }
  const requestBody = Buffer.from(request,"base64");
  const responseBody = Buffer.from(response,"base64");
  if (JSON.parse(responseBody.toString("utf8")).id !== data.analysis.id) {
    throw new Error("AI proof belongs to another completion.");
  }
  const {verifyModelAttestation,verifyModelResponse} = await import("@nearai/inference-sdk/node");
  const verified = await verifyModelAttestation({attestation,clientBinding:{nonce:attestation.nonce}});
  verifyModelResponse({requestBody,responseBody,signature,attestation:verified});
  console.log("Verified the NEAR AI model attestation and signature over the encrypted request and response.");
  console.log("The exported readable AI text is a separate field. The transcript proof covers the encrypted bytes.");
} else if (data.analysis) {
  console.log("This AI analysis has no portable proof.");
}
console.log("Off-chain remedy history requires separate verification.");
