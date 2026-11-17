import test from "node:test";
import assert from "node:assert/strict";
import {generateKeyPairSync,createHash,sign} from "node:crypto";
import {copySourceReceipt,sourceReceiptMessage,trustedSourceIssuers,verifySourceReceipt} from "../../lib/near-source-proof.mjs";

const {privateKey,publicKey} = generateKeyPairSync("ed25519");
const issuer = {id:"test-issuer",keyId:"key-1",label:"Fixture delivery service",publicKey:publicKey.export({format:"jwk"}).x};
const text = "Fixture delivery URL and access-grant description.";
const scope = {network:"testnet",escrow:"escrow.testnet",booking:"12",position:"0",version:"1"};
const entryHash = "b".repeat(64);
const recipient = "buyer.testnet";
const payload = {schema:"pactpay.delivery-source.v1",eventType:"access-granted",issuer:issuer.id,keyId:issuer.keyId,
  eventId:"delivery-event-1",scope,artifactDigest:createHash("sha256").update(text).digest("hex"),recipient,occurredAt:100,expiresAt:120};
const receipt = {entryHash,payload,signature:sign(null,sourceReceiptMessage(payload,entryHash),privateKey).toString("base64url")};
const input = {receipt,scope,recipient,openings:new Map([[entryHash,text]]),issuers:[issuer],now:110};

test("a trusted issuer receipt verifies only against its selected opening and agreement scope",async()=>{
  const result = await verifySourceReceipt(input);
  assert.equal(result.state,"verified");
  assert.match(result.detail,/Fixture delivery service/);
  assert.equal((await verifySourceReceipt(input)).state,"verified"); // Portable proofs can be read more than once.
  for (const key of ["booking","position","version"]) {
    assert.equal((await verifySourceReceipt({...input,scope:{...scope,[key]:"77"}})).reason,"source-scope-mismatch");
  }
  assert.equal((await verifySourceReceipt({...input,recipient:"someone.testnet"})).reason,"source-scope-mismatch");
  assert.equal((await verifySourceReceipt({...input,openings:new Map([[entryHash,text+"x"]])})).reason,"source-artifact-mismatch");
  const differentEntry = "c".repeat(64);
  assert.equal((await verifySourceReceipt({...input,receipt:{...receipt,entryHash:differentEntry},
    openings:new Map([[differentEntry,text]])})).reason,"source-signature-invalid");
});

test("receipt fields are signed and a proof file cannot declare an issuer trusted",async()=>{
  assert.equal((await verifySourceReceipt({...input,receipt:{...receipt,payload:{...payload,eventId:"changed"}}})).reason,"source-signature-invalid");
  assert.equal((await verifySourceReceipt({...input,issuers:[]})).state,"unavailable");
  assert.equal((await verifySourceReceipt({...input,openings:new Map()})).state,"unavailable");
  assert.equal((await verifySourceReceipt({...input,now:120})).reason,"source-receipt-outside-validity");
  assert.equal((await verifySourceReceipt({...input,now:99})).reason,"source-receipt-outside-validity");
  assert.equal((await verifySourceReceipt({...input,receipt:{...receipt,signature:receipt.signature+"="}})).reason,"source-receipt-invalid");
  assert.deepEqual(trustedSourceIssuers(JSON.stringify([issuer])),[issuer]);
  assert.deepEqual(trustedSourceIssuers(JSON.stringify([issuer,issuer])),[]);
  assert.deepEqual(copySourceReceipt({...receipt,secret:"canary",payload:{...payload,secret:"canary"}}),receipt);
});
