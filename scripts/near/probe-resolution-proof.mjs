import {readFile} from "node:fs/promises";
import {generateKeyPairSync} from "node:crypto";
import {prepareE2eeChatRequest,verifyModelResponse} from "@nearai/inference-sdk/node";
import assert from "node:assert/strict";

const input = JSON.parse(await readFile(new URL("../../docs/near/resolution-fixtures/synthetic-ai-case.json",import.meta.url),"utf8"));
const modelKey = {signingAlgo:"ed25519",publicKey:generateKeyPairSync("ed25519").publicKey.export({format:"der",type:"spki"}).subarray(-32).toString("hex")};
function plaintext(payload) {
  return JSON.stringify({model:"z-ai/glm-5.3-flash",messages:[{role:"user",content:JSON.stringify(payload)}]});
}
async function encrypt(payload) {
  const body = plaintext(payload);
  const prepared = await prepareE2eeChatRequest({
    request:new Request("https://example.invalid/v1/chat/completions",{method:"POST",body}),
    modelKey,
  });
  const encrypted = await prepared.request.text();
  assert.deepEqual(Object.keys(prepared).sort(),["decryptResponse","request"]);
  assert.ok(!encrypted.includes(input.sources[0].paragraphs[0]));
  assert.ok(!encrypted.includes(payload.nonce));
  return {body,encrypted};
}
const first = await encrypt(input);
const second = await encrypt({...input,nonce:"synthetic-case-b",booking:"2"});
assert.notEqual(first.encrypted,second.encrypted);
assert.equal(typeof verifyModelResponse,"function");
console.log(JSON.stringify({
  mode:"synthetic-local",
  sdk:"@nearai/inference-sdk 0.3.0",
  requestEncryption:"Passed",
  portableRequestOpening:"Unavailable",
  portableResponseOpening:"Unavailable",
  providerSignedTranscript:"Unavailable",
  plaintextTamper:"Unavailable",
  ciphertextSplice:"Unavailable",
  sourceTamper:"Unavailable",
  detail:"The public helper returns an encrypted Request and an in-memory response decryption closure. It exports neither a request opening nor the response-session key.",
},null,2));
