import {expect,test} from "vitest";
import workshop from "../../../docs/near/testnet-workshop-ai-proof.json";
import sample from "../../../public/pactpay-v2-sample-proof.json";
import type {AuthorizedResolutionProof} from "./proof";
import {mutateProof,verificationOutcome,scenarioResult} from "./verify-scenarios";
import {verifyPrivateFields} from "./verify-private";
import {agreementDigest} from "./canonical";
const original=workshop as unknown as AuthorizedResolutionProof;

test("named mutations preserve the original and invalidate its signed digest",async()=>{
  const saved=JSON.stringify(original);
  for(const id of ["amount","recipient","evidence-root"] as const){
    const mutation=mutateProof(original,id,sample as unknown as AuthorizedResolutionProof);
    expect(await agreementDigest(mutation.proof.proposal)).not.toBe(original.digest);
    expect(mutation.before).not.toEqual(mutation.after);
    expect(mutation.expectedCheck).toBe("agreementDigest");
  }
  expect(JSON.stringify(original)).toBe(saved);
});
test("foreign booking uses actual receipt, missing approval removes it, duplicate keeps same hash",()=>{
  expect(mutateProof(original,"booking",sample as unknown as AuthorizedResolutionProof).proof.receipts.approval).toEqual(sample.receipts.approval);
  expect(mutateProof(original,"approval").proof.receipts.approval).toBeUndefined();
  const claims=mutateProof(original,"duplicate").proof.receipts.claims;
  expect(claims.at(-1)).toEqual(claims[0]);
});
test("nonce mismatch fails locally before any provider verification",async()=>{
  const mutation=mutateProof(original,"nonce");
  expect(await agreementDigest(mutation.proof.proposal)).toBe(original.digest);
  const checks=await verifyPrivateFields(mutation.proof as AuthorizedResolutionProof);
  expect(checks).toContainEqual(expect.objectContaining({name:"aiTranscript",status:"Failed",reason:"attestation-nonce-mismatch"}));
  expect(scenarioResult(mutation,checks)).toContain("Rejected");
  expect(checks).toContainEqual(expect.objectContaining({name:"aiPlaintextBinding",status:"Unavailable"}));
});
test("outcomes never call unverified coverage valid",()=>{
  const pass={name:"agreementDigest",status:"Passed" as const};
  expect(verificationOutcome([],original)).toBe("Unavailable");
  expect(verificationOutcome([pass],original)).toBe("Incomplete");
  expect(verificationOutcome([{...pass,status:"Failed"}],original)).toBe("Invalid");
  expect(verificationOutcome([{...pass,status:"Unavailable"}],original)).toBe("Unavailable");
  const absent=mutateProof(original,"approval");
  expect(verificationOutcome([pass,...["bilateralApproval","claimPayments","contractVersionAndCode","evidenceSnapshot","aiTranscript"].map(name=>({name,status:"Unavailable" as const}))],absent.proof)).toBe("Incomplete");
  expect(scenarioResult(mutateProof(original,"amount"),[pass])).toContain("Not demonstrated");
});
