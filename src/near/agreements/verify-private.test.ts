import {expect,test} from "vitest";
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
    proposal:{...scope,position:"0",buyer:"buyer.testnet",merchant:"merchant.testnet",
      privateTermsCommitment:ciphertextHash,evidenceRoot:await verifyEvidenceManifest(scope,[entry])},
    authorized:{manifest:[entry],openings:[opening]},
  } as AuthorizedResolutionProof;
  expect((await verifyPrivateFields(proof)).map(x=>x.status)).toEqual(["Passed","Passed","Passed"]);
  expect((await verifyPrivateFields({...proof,authorized:{...proof.authorized,openings:[]}})).at(-1)?.status).toBe("Unavailable");
  opening.text+=" changed";
  expect((await verifyPrivateFields(proof)).at(-1)?.status).toBe("Failed");
});
