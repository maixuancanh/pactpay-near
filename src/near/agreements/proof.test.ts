import {expect,test} from "vitest";
import {authorizedResolutionProof, publicResolutionProof} from "./proof";
import type {AgreementV2} from "./types";

const digest = "a".repeat(64);
const proposal: AgreementV2 & {privateText:string} = {
  schema:"pactpay.resolution.v2", network:"testnet", escrow:"escrow.testnet", booking:"0", position:"1",
  version:"1", buyer:"buyer.testnet", merchant:"merchant.testnet",token:"token.testnet",
  termsCommitment:digest, evidenceRoot:digest, privateTermsCommitment:digest, assessmentDigest:null,
  immediateBuyer:"0",immediateMerchant:"12",retained:"8",successBuyer:"0",successMerchant:"8",
  fallbackBuyer:"8",fallbackMerchant:"0",acceptBy:"1",deliverBy:"2",reviewUntil:"3",salt:digest,privateText:"canary",
};
const dirtyRef = {hash:"x",signer:"buyer.testnet",apiKey:"canary"};

test("drops extra fields from public exports", () => {
  const data = {proposal,digest,codeHash:"C".repeat(43),receipts:{proposal:dirtyRef,claims:[dirtyRef]},walletKey:"canary"};
  expect(JSON.stringify(publicResolutionProof(data))).not.toContain("canary");
});

test("requires explicit approval to export authorized evidence", () => {
  const publicProof = publicResolutionProof({proposal,digest,codeHash:"C".repeat(43),receipts:{claims:[]}});
  const materials = {manifest:[],openings:[]};
  expect(() => authorizedResolutionProof(publicProof,materials,false)).toThrow("Confirm disclosure");
  expect(authorizedResolutionProof(publicProof,materials,true).authorized).toMatchObject(materials);
});
