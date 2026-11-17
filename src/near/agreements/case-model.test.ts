import {expect,test} from "vitest";
import {scopeKey,summarizeCaseChecks} from "./case-model";
import {resolutionProofScope} from "./proof";
import type {CaseScope} from "./case-model";

const scope:CaseScope={network:"testnet",escrow:"escrow.testnet",booking:"12",position:"0",version:"1"};

test("each case field has an independent effect on scope identity",()=>{
  const alternatives=[{escrow:"second.testnet"},{booking:"13"},{position:"1"},{version:"2"}];
  for (const change of alternatives) expect(scopeKey({...scope,...change})).not.toBe(scopeKey(scope));
  expect(()=>scopeKey({...scope,network:"mainnet"} as unknown as CaseScope)).toThrow(/network/);
});

test("invalid or noncanonical IDs cannot enter the case model",()=>{
  for (const field of ["booking","position","version"] as const) {
    for (const value of ["","-1","1.5"," 1","01"]) {
      expect(()=>scopeKey({...scope,[field]:value})).toThrow(field);
    }
  }
  expect(()=>resolutionProofScope({network:"testnet",escrow:"other.testnet",proposal:scope})).toThrow(/scope/);
});

test("each verification result uses only its own evidence",()=>{
  const checks=summarizeCaseChecks([
    {name:"evidenceSnapshot",status:"Passed"},
    {name:"aiTranscript",status:"Passed",reason:"model-signature-verified"},
    {name:"claimPayments",status:"Failed"},
  ]);
  expect(checks).toMatchObject({
    commitment:{state:"verified"},source:{state:"unavailable"},
    encryptedTranscript:{state:"verified",reason:"model-signature-verified"},
    plaintextBinding:{state:"unavailable"},approval:{state:"unavailable"},
    payout:{state:"invalid"},
  });
});
