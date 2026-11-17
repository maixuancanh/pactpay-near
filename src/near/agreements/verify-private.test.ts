import {expect,test,vi} from "vitest";
import {createHash,generateKeyPairSync,sign} from "node:crypto";
import {sourceReceiptMessage} from "../../../lib/near-source-proof.mjs";
import type {SourceReceipt} from "../../../lib/near-source-proof.mjs";
import {decode,encode} from "../evidence-crypto";
import {hashEvidenceEntry,verifyEvidenceManifest} from "./evidence-manifest";
import type {EvidenceEntry} from "./evidence-manifest";
import type {AuthorizedResolutionProof} from "./proof";
import {verifyPrivateFields} from "./verify-private";

test("checks private evidence locally and rejects changed plaintext",async()=>{
  const scope={network:"testnet" as const,escrow:"escrow.testnet",booking:"0",position:0};
  const raw=new Uint8Array(32).fill(5), iv=new Uint8Array(12).fill(6);
  const key=await crypto.subtle.importKey("raw",raw,"AES-GCM",false,["encrypt"]);
  const text="Synthetic private terms";
  const ciphertext=encode(await crypto.subtle.encrypt({name:"AES-GCM",iv},key,new TextEncoder().encode(text)));
  const packed=new Uint8Array([...iv,...decode(ciphertext)]);
  const ciphertextHash=Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256",packed)),x=>x.toString(16).padStart(2,"0")).join("");
  const entry:EvidenceEntry={case:scope,author:"buyer.testnet",sequence:1,previousEntryHash:null,supersedes:null,
    kind:"agreement_terms",ciphertextHash,sourceLocator:"buyer.testnet/entries/1",createdAt:"2026-11-14T00:00:00.000Z",entryHash:""};
  entry.entryHash=await hashEvidenceEntry(entry);
  const opening={entryHash:entry.entryHash,iv:encode(iv),ciphertext,excerptKey:encode(raw),text};
  const proof={
    proposal:{...scope,position:"0",version:"1",buyer:"buyer.testnet",merchant:"merchant.testnet",
      privateTermsCommitment:ciphertextHash,evidenceRoot:await verifyEvidenceManifest(scope,[entry])},
    authorized:{manifest:[entry],openings:[opening]},
  } as AuthorizedResolutionProof;
  expect(await verifyPrivateFields(proof)).toEqual(expect.arrayContaining([
    expect.objectContaining({name:"evidenceSnapshot",status:"Passed"}),
    expect.objectContaining({name:"privateTermsCommitment",status:"Passed"}),
    expect.objectContaining({name:"evidencePlaintext",status:"Passed"}),
    expect.objectContaining({name:"evidenceSource",status:"Unavailable"}),
    expect.objectContaining({name:"aiPlaintextBinding",status:"Unavailable"}),
  ]));
  expect((await verifyPrivateFields({...proof,authorized:{...proof.authorized,openings:[]}}))
    .find(check=>check.name==="evidencePlaintext")?.status).toBe("Unavailable");
  const {privateKey,publicKey}=generateKeyPairSync("ed25519");
  const now=Math.floor(Date.now()/1000);
  const payload:SourceReceipt["payload"]={schema:"pactpay.delivery-source.v1",eventType:"access-granted",
    issuer:"fixture",keyId:"1",eventId:"delivery-1",scope:{...scope,position:"0",version:"1"},
    artifactDigest:createHash("sha256").update(text).digest("hex"),recipient:proof.proposal.buyer,occurredAt:now-1,expiresAt:now+60};
  const sourceReceipt={payload,entryHash:entry.entryHash,
    signature:sign(null,sourceReceiptMessage(payload,entry.entryHash),privateKey).toString("base64url")};
  const withSource={...proof,authorized:{...proof.authorized,sourceReceipt}};
  vi.stubEnv("VITE_NEAR_SOURCE_ISSUERS",JSON.stringify([{id:"fixture",keyId:"1",label:"Fixture issuer",
    publicKey:publicKey.export({format:"jwk"}).x}]));
  try {
    expect((await verifyPrivateFields(withSource)).find(check=>check.name==="evidenceSource"))
      .toMatchObject({status:"Passed",reason:"source-access-grant-verified"});
    opening.text+=" changed";
    expect((await verifyPrivateFields(withSource)).find(check=>check.name==="evidenceSource"))
      .toMatchObject({status:"Unavailable",reason:"source-opening-missing"});
  } finally {
    vi.unstubAllEnvs();
  }
  expect((await verifyPrivateFields(proof)).find(check=>check.name==="evidencePlaintext")?.status).toBe("Failed");
});
