import {expect,test} from "vitest";
import {resolutionAssessmentDigest} from "./assessment-digest.mjs";
const scope={network:"testnet" as const,escrow:"e.testnet",booking:"1",position:"0",version:"1",evidenceRoot:"a".repeat(64),termsCommitment:"b".repeat(64)};
const material={model:"test",promptVersion:"1",inputHash:"c".repeat(64),outputHash:"d".repeat(64),proof:{request:"r",response:"s",expectedAttestationNonce:"a".repeat(64)}};
test("commits independently captured nonce and prevents replay to other scopes",async()=>{
 const digest=await resolutionAssessmentDigest(scope,material);
 expect(await resolutionAssessmentDigest(scope,{...material,proof:{...material.proof,expectedAttestationNonce:"b".repeat(64)}})).not.toBe(digest);
 const {expectedAttestationNonce,...legacy}=material.proof;
 expect(await resolutionAssessmentDigest(scope,{...material,proof:legacy})).not.toBe(digest);
 for(const key of ["booking","position","version","evidenceRoot","termsCommitment","escrow"] as const) {
   expect(await resolutionAssessmentDigest({...scope,[key]:scope[key]+"2"},material)).not.toBe(digest);
 }
});
