import {expect,test,vi} from "vitest";
import {ExportableInferenceClient} from "./claimguard";
class TestClient extends ExportableInferenceClient {
  transport() {return this.createGatewayFetch();}
  capture() {this.registerResponse({id:"reply",requestBody:new Uint8Array(),responseBody:Promise.resolve(new Uint8Array())} as Parameters<TestClient["registerResponse"]>[0],0);}
}
test("exports the outbound challenge captured before dispatch, never the report nonce",async()=>{
  const nonce="a".repeat(64);
  vi.stubGlobal("fetch",vi.fn(async()=>new Response("{}")));
  try {
    const client=new TestClient({apiKey:"fixture"});
    await client.transport()(new Request(`https://example.test/attestation/report?model=test&provider=near&nonce=${nonce}`));
    client.capture();
    vi.spyOn(client,"verifyResponse").mockResolvedValue({signatureKind:"provider_tee",signature:{kind:"provider_tee"},attestation:{report:{nonce}}} as never);
    expect(await client.exportProof("reply")).toMatchObject({expectedAttestationNonce:nonce});
    vi.mocked(client.verifyResponse).mockResolvedValue({signatureKind:"provider_tee",signature:{kind:"provider_tee"},attestation:{report:{nonce:"b".repeat(64)}}} as never);
    await expect(client.exportProof("reply")).rejects.toThrow(/nonce/i);
  } finally {vi.unstubAllGlobals();}
});
test("refuses export without an independently captured challenge",async()=>{
  const client=new TestClient({apiKey:"fixture"});client.capture();
  vi.spyOn(client,"verifyResponse").mockResolvedValue({signatureKind:"provider_tee",attestation:{report:{nonce:"a".repeat(64)}}} as never);
  await expect(client.exportProof("reply")).rejects.toThrow(/nonce/i);
});
