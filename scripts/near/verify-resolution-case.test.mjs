import {test} from "node:test";
import assert from "node:assert/strict";
import {agreementDigest} from "../../src/near/agreements/canonical.ts";
import {verifyResolutionCase} from "./verify-resolution-case.mjs";

const hex = "a".repeat(64);
const contract = "escrow-v2.example.testnet";
const buyer = "buyer.testnet";
const merchant = "merchant.testnet";
const proposal = {
  schema:"pactpay.resolution.v2", network:"testnet", escrow:contract, booking:"0", position:"0",
  version:"1", buyer, merchant, token:"token.testnet", termsCommitment:hex,
  evidenceRoot:hex, privateTermsCommitment:hex, assessmentDigest:null,
  immediateBuyer:"0", immediateMerchant:"12", retained:"8", successBuyer:"0", successMerchant:"8",
  fallbackBuyer:"8", fallbackMerchant:"0", acceptBy:"10", deliverBy:"20", reviewUntil:"30", salt:hex,
};
const digest = await agreementDigest(proposal);
const proposalRef = {hash:"A".repeat(43), signer:buyer};
const approvalRef = {hash:"B".repeat(43), signer:merchant};
const block = "C".repeat(43);
const bundle = {
  schema:"pactpay.resolution-proof.v2", network:"testnet", escrow:contract, contractVersion:2,
  codeHash:"D".repeat(43), proposal, digest, receipts:{proposal:proposalRef, approval:approvalRef, claims:[]},
};
function tx(ref, method, args) {
  const agreementLog = method === "propose_agreement" || method === "approve_agreement" ? [
    "EVENT_JSON:"+JSON.stringify({
      standard:"pactpay",version:"2.0.0",event:method === "propose_agreement" ? "agreement_proposed" : "agreement_activated",
      data:[{booking:String(args.id),position:String(args.index),version:"1",digest,actor:ref.signer,
        status:method === "propose_agreement" ? "Proposed" : "Active",approvals:method === "propose_agreement" ? 1 : 3}],
    }),
  ] : [];
  return {
    final_execution_status:"FINAL", status:{SuccessValue:""},
    transaction:{hash:ref.hash, signer_id:ref.signer, receiver_id:contract,
      actions:[{FunctionCall:{method_name:method,args:Buffer.from(JSON.stringify(args)).toString("base64")}}]},
    receipts_outcome:[{block_hash:block,id:"E".repeat(43),outcome:{executor_id:contract,status:{SuccessValue:""},logs:agreementLog}}],
  };
}
function reader() {
  return {
    transaction:async hash => hash === proposalRef.hash
      ? tx(proposalRef,"propose_agreement",{id:0,index:0,proposal})
      : tx(approvalRef,"approve_agreement",{id:0,index:0,version:"1",digest}),
    codeHash:async () => bundle.codeHash,
    view:async (_escrow, method) => method === "contract_version" ? 2 : ({
      proposal,digest,status:"Active",approvals:3,
    }),
  };
}
function status(result, name) {
  return result.checks.find(check => check.name === name)?.status;
}
test("checks two historical approvals and reports missing evidence and payout", async () => {
  const result = await verifyResolutionCase(bundle, reader());
  assert.equal(status(result,"agreementDigest"),"Passed");
  assert.equal(status(result,"bilateralApproval"),"Passed");
  assert.equal(status(result,"claimPayments"),"Unavailable");
  assert.equal(result.ok,false);
});
test("rejects a forged digest and an approval by the proposer", async () => {
  assert.equal(status(await verifyResolutionCase({...bundle,digest:hex}, reader()),"agreementDigest"),"Failed");
  const sameSigner = {...bundle, receipts:{...bundle.receipts,approval:{...approvalRef,signer:buyer}}};
  assert.equal(status(await verifyResolutionCase(sameSigner, reader()),"bilateralApproval"),"Failed");
});
test("a historical lookup failure reports Unavailable", async () => {
  const rpc = {...reader(), transaction:async () => {throw new Error("pruned");}};
  assert.equal(status(await verifyResolutionCase(bundle,rpc),"bilateralApproval"),"Unavailable");
});
test("rejects a receipt reference cloned from a different booking", async () => {
  const rpc = {...reader(), transaction:async hash => hash === proposalRef.hash
    ? tx(proposalRef,"propose_agreement",{id:99,index:0,proposal})
    : tx(approvalRef,"approve_agreement",{id:0,index:0,version:"1",digest})};
  assert.equal(status(await verifyResolutionCase(bundle,rpc),"bilateralApproval"),"Failed");
});

test("rejects an evidence manifest from another case", async () => {
  const forged = {...bundle, authorized:{manifest:[{case:{network:"testnet",escrow:contract,booking:"1",position:0}}], openings:[]}};
  assert.equal(status(await verifyResolutionCase(forged,reader()),"evidenceSnapshot"),"Failed");
});

test("recomputes the committed empty evidence manifest", async () => {
  const {verifyEvidenceManifest} = await import("../../src/near/agreements/evidence-manifest.mjs");
  const scope = {network:"testnet",escrow:contract,booking:"0",position:0};
  const bound = {...proposal,evidenceRoot:await verifyEvidenceManifest(scope,[])};
  const withManifest = {...bundle,proposal:bound,digest:await agreementDigest(bound),authorized:{manifest:[],openings:[]}};
  const result = await verifyResolutionCase(withManifest,reader());
  assert.equal(status(result,"evidenceSnapshot"),"Passed");
  assert.equal(status(result,"evidencePlaintext"),"Passed");
});

test("keeps signed ciphertext checks distinct from portable plaintext binding", async () => {
  const aiProposal = {...proposal,assessmentDigest:hex};
  const aiBundle = {...bundle,proposal:aiProposal,digest:await agreementDigest(aiProposal),
    authorized:{manifest:[],openings:[],transcript:{id:"synthetic",version:1,request:"@@",response:"",signature:{kind:"provider_tee"},attestation:{nonce:"synthetic"}}}};
  const result = await verifyResolutionCase(aiBundle, reader());
  assert.equal(status(result,"aiTranscript"),"Failed");
  assert.equal(status(result,"aiPlaintextBinding"),"Unavailable");
});

test("binds Paid ledger records to finalized token movement and rejects a recipient swap", async () => {
  const claimRefs = [{hash:"F".repeat(43),signer:merchant},{hash:"G".repeat(43),signer:merchant}];
  const event = (standard,version,name,data) => "EVENT_JSON:"+JSON.stringify({standard,version,event:name,data:[data]});
  const claims = claimRefs.map((_,i) => ({
    claim_id:String(i+1),agreement_version:"1",recipient:merchant,amount:i === 0 ? "12" : "8",status:"Paid",attempt_nonce:"1",
  }));
  const claimBundle = {...bundle,receipts:{...bundle.receipts,claims:claimRefs}};
  function rpc(swapRecipient, forgedPaid) {
    const original = reader();
    return {
      ...original,
      transaction:async (hash,signer) => {
        const i = claimRefs.findIndex(ref => ref.hash === hash);
        if (i < 0) return original.transaction(hash,signer);
        const record = claims[i];
        const claim = {...record,booking:"0",position:"0",version:"1",token:proposal.token};
        const result = tx(claimRefs[i],"claim_v2",{claim_id:record.claim_id});
        result.receipts_outcome[0].outcome.logs = [
          event("pactpay","2.0.0","claim_pending",{...claim,status:"Pending"}),
          event("pactpay","2.0.0","claim_paid",claim),
        ];
        result.receipts_outcome.push({block_hash:block,outcome:{executor_id:proposal.token,status:{SuccessValue:""},logs:[
          event("nep141","1.0.0","ft_transfer",{old_owner_id:contract,new_owner_id:swapRecipient ? buyer : merchant,amount:claim.amount}),
        ]}});
        return result;
      },
      view:async (...args) => args[1] === "get_claims"
        ? claims.map(record => forgedPaid ? {...record,status:"Pending"} : record)
        : args[1] === "get_agreement" ? {proposal,digest,status:"Completed",approvals:3} : original.view(...args),
    };
  }
  assert.equal(status(await verifyResolutionCase(claimBundle,rpc(false,false)),"claimPayments"),"Passed");
  const duplicate={...claimBundle,receipts:{...claimBundle.receipts,claims:[...claimRefs,claimRefs[0]]}};
  const repeated=await verifyResolutionCase(duplicate,rpc(false,false));
  assert.equal(status(repeated,"claimPayments"),"Failed");
  assert.match(repeated.checks.find(check=>check.name==="claimPayments").detail,/Duplicate claim history/);
  assert.equal(status(await verifyResolutionCase(claimBundle,rpc(true,false)),"claimPayments"),"Failed");
  assert.equal(status(await verifyResolutionCase(claimBundle,rpc(false,true)),"claimPayments"),"Failed");
});

test("verifies a reconciled payout and rejects a mismatched transfer receipt", async () => {
  const ref = {hash:"F".repeat(43),signer:merchant};
  const repair = {hash:"G".repeat(43),signer:contract};
  const [start,transfer,callback] = ["H","J","K"].map(c=>c.repeat(43));
  const event=(standard,version,name,data)=>"EVENT_JSON:"+JSON.stringify({standard,version,event:name,data:[data]});
  const payout={claim_id:"1",attempt_nonce:"1",version:"1",booking:"0",position:"0",token:proposal.token,recipient:merchant,amount:"12"};
  const repairArgs={claim_id:"1",attempt_nonce:"1",transfer_receipt:transfer};
  const receipt=(receipt_id,predecessor_id,receiver_id,method_name,args)=>({
    receipt_id,predecessor_id,receiver_id,receipt:{Action:{actions:[{FunctionCall:{
      method_name,args:Buffer.from(JSON.stringify(args)).toString("base64"),
    }}]}},
  });
  const original=tx(ref,"claim_v2",{claim_id:"1"});
  original.transaction_outcome={outcome:{status:{SuccessReceiptId:start}}};
  original.receipts=[
    receipt(start,merchant,contract,"claim_v2",{claim_id:"1"}),
    receipt(transfer,contract,proposal.token,"ft_transfer",{receiver_id:merchant,amount:"12"}),
    receipt(callback,contract,contract,"finish_claim_v2",{claim_id:"1",attempt_nonce:"1"}),
  ];
  original.receipts_outcome=[
    {id:start,outcome:{executor_id:contract,status:{SuccessReceiptId:callback},receipt_ids:[transfer,callback],logs:[
      event("pactpay","2.0.0","claim_pending",{...payout,status:"Pending"})]}},
    {id:transfer,outcome:{executor_id:proposal.token,status:{SuccessValue:""},logs:[
      event("nep141","1.0.0","ft_transfer",{old_owner_id:contract,new_owner_id:merchant,amount:"12"})]}},
    {id:callback,outcome:{executor_id:contract,status:{Failure:{}},logs:[]}},
  ];
  const rpc=reader();
  const fallback = {...proposal,successMerchant:"0",retained:"0",fallbackBuyer:"0"};
  const single = {...fallback,immediateMerchant:"12"};
  const singleDigest=await agreementDigest(single);
  const proof={...bundle,proposal:single,digest:singleDigest,
    receipts:{...bundle.receipts,claims:[{...ref,reconciliation:repair}]}};
  function chain(args) {
    const fixed=tx(repair,"reconcile_paid_claim_v2",args);
    fixed.receipts_outcome[0].outcome.logs=[
      event("pactpay","2.0.0","claim_reconciled",{...payout,status:"Paid"}),
      event("pactpay","2.0.0","reconciliation_receipt",args),
    ];
    return {...rpc,
      transaction:(hash,signer)=>{
        if (hash===ref.hash) return original;
        if (hash===repair.hash) return fixed;
        const first=hash===proposalRef.hash;
        const approval=tx(first ? proposalRef : approvalRef,first ? "propose_agreement" : "approve_agreement",
          first ? {id:0,index:0,proposal:single} : {id:0,index:0,version:"1",digest:singleDigest});
        approval.receipts_outcome[0].outcome.logs=approval.receipts_outcome[0].outcome.logs.map(log=>log.replace(digest,singleDigest));
        return approval;
      },
      view:(...args)=>args[1]==="get_claims" ? [{...payout,agreement_version:"1",status:"Paid"}]
        : args[1]==="get_agreement" ? {proposal:single,digest:singleDigest,status:"Completed",approvals:3} : rpc.view(...args),
    };
  }
  assert.equal(status(await verifyResolutionCase(proof,chain(repairArgs)),"claimPayments"),"Passed");
  assert.equal(status(await verifyResolutionCase(proof,chain({...repairArgs,transfer_receipt:"L".repeat(43)})),"claimPayments"),"Failed");
  const tokenOutcome=original.receipts_outcome[1].outcome;
  const originalStatus=tokenOutcome.status;
  const originalLogs=tokenOutcome.logs;
  tokenOutcome.status={Failure:{}};
  tokenOutcome.logs=[];
  assert.equal(status(await verifyResolutionCase(proof,chain(repairArgs)),"claimPayments"),"Failed");
  tokenOutcome.status=originalStatus;
  tokenOutcome.logs=originalLogs;
  original.receipts_outcome[2].outcome.status={SuccessValue:"dHJ1ZQ=="};
  assert.equal(status(await verifyResolutionCase(proof,chain(repairArgs)),"claimPayments"),"Failed");
});

test("decrypts authorized evidence and detects edited plaintext, ciphertext and terms", async () => {
  const {createCipheriv,createHash} = await import("node:crypto");
  const {hashEvidenceEntry,verifyEvidenceManifest} = await import("../../src/near/agreements/evidence-manifest.mjs");
  const iv = Buffer.alloc(12,2);
  const key = Buffer.alloc(32,1);
  const text = "Synthetic resolution terms.";
  const cipher = createCipheriv("aes-256-gcm",key,iv);
  const encrypted = Buffer.concat([cipher.update(text),cipher.final(),cipher.getAuthTag()]);
  const scope = {network:"testnet",escrow:contract,booking:"0",position:0};
  const entry = {case:scope,author:buyer,sequence:1,previousEntryHash:null,
    ciphertextHash:createHash("sha256").update(iv).update(encrypted).digest("hex"),supersedes:null,
    sourceLocator:buyer+"/entries/1",createdAt:"2026-11-14T00:00:00.000Z",kind:"agreement_terms"};
  entry.entryHash = await hashEvidenceEntry(entry);
  const bound = {...proposal,evidenceRoot:await verifyEvidenceManifest(scope,[entry]),privateTermsCommitment:entry.ciphertextHash};
  const opening = {entryHash:entry.entryHash,iv:iv.toString("base64"),excerptKey:key.toString("base64"),
    ciphertext:encrypted.toString("base64"),text};
  const proof = {...bundle,proposal:bound,digest:await agreementDigest(bound),authorized:{manifest:[entry],openings:[opening]}};
  let result = await verifyResolutionCase(proof,reader());
  assert.equal(status(result,"privateTermsCommitment"),"Passed");
  assert.equal(status(result,"evidencePlaintext"),"Passed");
  for (const patch of [{text:text+"edits"},{ciphertext:Buffer.alloc(encrypted.length,4).toString("base64")}]) {
    result = await verifyResolutionCase({...proof, authorized:{manifest:[entry],openings:[{...opening,...patch}]}},reader());
    assert.equal(status(result,"evidencePlaintext"),"Failed");
  }
  result = await verifyResolutionCase({...proof,proposal:{...bound,privateTermsCommitment:hex}},reader());
  assert.equal(status(result,"privateTermsCommitment"),"Failed");
});

test("named exported-proof mutations reject amounts, recipients and evidence roots",async()=>{
  for (const patch of [{immediateMerchant:"13"},{merchant:"changed-recipient.testnet"},{evidenceRoot:"b".repeat(64)}]) {
    const result=await verifyResolutionCase({...bundle,proposal:{...proposal,...patch}},reader());
    assert.equal(status(result,"agreementDigest"),"Failed");
    assert.equal(result.ok,false);
  }
});
test("removed approval is missing evidence, not a valid or forged approval",async()=>{
  const missing=structuredClone(bundle);
  delete missing.receipts.approval;
  const result=await verifyResolutionCase(missing,reader());
  assert.equal(status(result,"bilateralApproval"),"Unavailable");
  assert.equal(result.ok,false);
});
