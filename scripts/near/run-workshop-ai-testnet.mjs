import {chromium} from "@playwright/test";
import {KeyPair} from "near-api-js";
import {resolve} from "node:path";
import {nep413Digest} from "../../lib/near-evidence.mjs";
import {caseReader} from "../../lib/near-case-rpc.mjs";
import {finalizedCall,verifyResolutionCase} from "./verify-resolution-case.mjs";
import {hashEvidenceEntry,verifyEvidenceManifest} from "../../src/near/agreements/evidence-manifest.mjs";
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
const keys = process.env.PACTPAY_DEMO_KEY_DIR;
assert.ok(keys, "Set PACTPAY_DEMO_KEY_DIR to the dedicated Testnet demo credentials directory.");
const credential = async file => JSON.parse(await readFile(resolve(keys,file),"utf8"));
async function load(file) {
  const record=await credential(file);
  assert.match(record.accountId,/\.testnet$/);
  return new Account(record.accountId,rpc,KeyPairSigner.fromSecretKey(record.secretKey));
}
const merchant=await load("deploy-key.json");
const buyer=await load("b05bfd.pactpay-530c506b.testnet.json");
const refs={};
const retryable=true;
const output=".near-testnet-workshop-journal.json";
const hosted="https://pactpay-near-testnet-web.vercel.app";
const local="http://127.0.0.1:5178";
async function evidenceRequest(action, data, session) {
  const response=await fetch(hosted+"/api/near-evidence",{
    method:"POST",headers:{"content-type":"application/json",...(session ? {authorization:"Bearer "+session} : {})},
    body:JSON.stringify({action,escrow,...data}),signal:AbortSignal.timeout(25000),
  });
  if (!response.ok) throw Error(action+" HTTP "+response.status);
  return response.json();
}
async function assessmentFor(scope, terms, sources) {
  const key=KeyPair.fromString((await credential("b05bfd.pactpay-530c506b.testnet.json")).secretKey);
  const challenge=await evidenceRequest("challenge",{account:buyer.accountId});
  const signature=key.sign(nep413Digest(challenge.nonce,challenge.message,challenge.recipient)).signature;
  const {session}=await evidenceRequest("login",{accountId:buyer.accountId,token:challenge.token,
    publicKey:key.getPublicKey().toString(),signature:Buffer.from(signature).toString("base64")});
  const browser=await chromium.launch({channel:"chrome"});
  try {
    const page=await browser.newPage();
    await page.route(/\/api\/near-/, async route => {
      const req=route.request();
      const remote=new URL(req.url());
      try {
        const response=await route.fetch({url:hosted+remote.pathname+remote.search,timeout:55000});
        console.log("AI gateway",req.method(),remote.pathname,response.status());
        if (!response.ok()) console.log((await response.text()).slice(0,350));
        await route.fulfill({response});
      } catch (error) {
        console.error("AI gateway transport failed",remote.pathname,error.name);
        await route.abort("failed");
      }
    });
    await page.goto(local+"/verify");
    const {ticket}=await evidenceRequest("ai_ticket",{booking:scope.booking,position:0},session);
    return await page.evaluate(async ({ticket,scope,terms,sources}) => {
      const {analyzeResolutionEvidence}=await import("/src/near/claimguard.ts");
      try {
        return await analyzeResolutionEvidence(ticket,scope,terms,sources);
      } catch (error) {
        throw new Error([error.message,error.cause?.message,error.cause?.cause?.message].filter(Boolean).join(" | "));
      }
    },{ticket,scope,terms,sources});
  } finally {
    await browser.close();
  }
}

let id;
async function call(name,signer,method,args,deposit=0n,receiver=escrow) {
  const send=()=>signer.signAndSendTransaction({
    receiverId:receiver,waitUntil:"FINAL",throwOnFailure:true,
    actions:[transactions.functionCall(method,args,100_000_000_000_000n,deposit)],
  });
  const result=await send().catch(error=>{ if (error?.type==="Expired") return send(); throw error; });
  assert.equal(typeof result.status?.SuccessValue,"string",JSON.stringify(result.status));
  refs[name]={hash:result.transaction.hash,signer:signer.accountId};
  await writeFile(output,JSON.stringify({escrow,token,id,transactions:refs},null,2)+"\n");
  return Buffer.from(result.status.SuccessValue,"base64").toString();
}
const time=async()=>Number(BigInt((await rpc.block({finality:"final"})).header.timestamp_nanosec)/1_000_000_000n);
const walletBalance=address=>view("ft_balance_of",{account_id:address},token);
if (process.argv.includes("--probe")) {
  const journal=JSON.parse(await readFile(output,"utf8"));
  const a=await assessmentFor({network:"testnet",escrow,booking:String(journal.id),position:"0",version:"1",
    evidenceRoot:"a".repeat(64),termsCommitment:"b".repeat(64)},"Synthetic connection probe",
    [{id:"c".repeat(64),paragraphs:["The merchant reports the workshop ended without sharing a recording link."]}]);
  console.log("Connection probe",a.transcriptStatus,Boolean(a.proof.expectedAttestationNonce));
  process.exit(0);
}
for(const signer of [buyer,merchant]) {
  if(!await view("storage_balance_of",{account_id:signer.accountId},token)) {
    const {min}=await view("storage_balance_bounds",{},token);
    await call("register_"+signer.accountId,merchant,"storage_deposit",{account_id:signer.accountId,registration_only:true},BigInt(min),token);
  }
}
if(BigInt(await walletBalance(buyer.accountId))<20n) await call("seed",merchant,"ft_transfer",{receiver_id:buyer.accountId,amount:"20"},1n,token);
const now=await time(), end=now+70;
const hash=value=>createHash("sha256").update(value).digest("hex");
const termsText="Synthetic workshop agreement. The merchant must provide the recording to the buyer after the live workshop. Private reference: "+randomBytes(32).toString("hex");
const terms=hash(termsText);
const deposit=BigInt(await view("booking_storage_deposit",{positions:1}));
id=Number(await call("create",merchant,"create_booking",{terms_commitment:terms,fund_until:String(now+58),
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
const evidenceText="The live workshop took place. The buyer reported that no recording link had been provided.";
const scope={network:"testnet",escrow,booking:String(id),position:0};
const manifest=[],openings=[];
for (const [kind,text] of [["agreement_terms",termsText],["evidence",evidenceText]]) {
  const raw=randomBytes(32),iv=randomBytes(12);
  const key=await crypto.subtle.importKey("raw",raw,"AES-GCM",false,["encrypt"]);
  const ciphertext=Buffer.from(await crypto.subtle.encrypt({name:"AES-GCM",iv},key,Buffer.from(text)));
  const sequence=manifest.length+1,author=merchant.accountId;
  const entry={case:scope,author,sequence,previousEntryHash:manifest.at(-1)?.entryHash??null,
    ciphertextHash:createHash("sha256").update(iv).update(ciphertext).digest("hex"),
    supersedes:null,sourceLocator:author+"/entries/"+sequence,createdAt:new Date().toISOString(),kind};
  entry.entryHash=await hashEvidenceEntry(entry);
  manifest.push(entry);
  openings.push({entryHash:entry.entryHash,iv:iv.toString("base64"),ciphertext:ciphertext.toString("base64"),
    excerptKey:raw.toString("base64"),text});
}
const evidenceRoot=await verifyEvidenceManifest(scope,manifest);
await writeFile(".near-testnet-workshop-input.json",JSON.stringify({id,termsText,manifest,openings,evidenceRoot,terms},null,2));
await call("commit",merchant,"revise_evidence",{...base,commitment:evidenceRoot});
const analysis=await assessmentFor({...scope,position:"0",version:"1",evidenceRoot,termsCommitment:terms},
  termsText,[{id:manifest[1].entryHash,paragraphs:[evidenceText]}]);
assert.equal(analysis.proof.expectedAttestationNonce,analysis.proof.attestation.nonce);
assert.ok([...analysis.assessment.claims,...analysis.assessment.conflictingClaims].some(claim=>claim.supported),"The model produced no cited finding.");
await writeFile(".near-testnet-workshop-transcript.json",JSON.stringify({analysis,manifest,openings},null,2));
console.log("NEAR AI signed transcript and request challenge verified for booking",id);
const beforeApproval=await view("get_position_ledger",base);
assert.equal(beforeApproval.paid,"0");
assert.equal(beforeApproval.pending,"0");
assert.equal((await view("get_claims",base)).length,0);
const current=await time();
const proposal={schema:"pactpay.resolution.v2",network:"testnet",escrow,booking:String(id),position:"0",version:"1",
  buyer:buyer.accountId,merchant:merchant.accountId,token,termsCommitment:terms,evidenceRoot,
  privateTermsCommitment:manifest[0].ciphertextHash,assessmentDigest:analysis.digest,
  immediateBuyer:"0",immediateMerchant:"12",retained:"8",successBuyer:"0",successMerchant:"8",
  fallbackBuyer:"5",fallbackMerchant:"3",acceptBy:String(current+300),deliverBy:String(current+600),
  reviewUntil:String(current+900),salt:randomBytes(32).toString("hex")};
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

const reader=caseReader(AbortSignal.timeout(45000));
const approved=await finalizedCall(reader,refs.approve,escrow,"approve_agreement");
const {id:completion,model,promptVersion,inputHash,outputHash}=analysis;
const proof={schema:"pactpay.resolution-proof.v2",network:"testnet",escrow,contractVersion:2,
  codeHash:await reader.codeHash(escrow,approved.block),proposal,digest,
  receipts:{proposal:refs.proposal,approval:refs.approve,claims:[refs.claim_12,refs.claim_8]},
  authorized:{manifest,openings,transcript:{...analysis.proof,id:completion,model,promptVersion,inputHash,outputHash}}};
await writeFile("docs/near/testnet-workshop-ai-proof.json",JSON.stringify(proof,null,2)+"\n");
const result=await verifyResolutionCase(proof,reader);
console.log(JSON.stringify(result,null,2));
for (const name of ["agreementDigest","bilateralApproval","evidenceSnapshot","evidencePlaintext","claimPayments","aiTranscript","aiAttestationNonce"]) {
  assert.equal(result.checks.find(check=>check.name===name)?.status,"Passed",name);
}
