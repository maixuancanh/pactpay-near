import {describe,it,expect} from "vitest";
import {createEvidenceKey,restoreEvidenceKey,encryptEvidence,decryptEvidence,decode} from "./evidence-crypto";

describe("private evidence",()=>{
  it("restores both recipient keys and rejects tampered ciphertext and wrong recovery codes",async()=>{
    const [buyer,merchant]=await Promise.all([createEvidenceKey(),createEvidenceKey()]);
    const [buyerKey,merchantKey]=await Promise.all([
      restoreEvidenceKey(buyer.profile,buyer.code),restoreEvidenceKey(merchant.profile,merchant.code),
    ]);
    await expect(restoreEvidenceKey(buyer.profile,merchant.code)).rejects.toThrow();
    const evidence=await encryptEvidence("Private receipt 123",{buyer:buyer.profile.key,merchant:merchant.profile.key});
    const bytes=new Uint8Array([...decode(evidence.iv),...decode(evidence.ciphertext)]);
    const id=Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256",bytes)),v=>v.toString(16).padStart(2,"0")).join("");
    expect(await decryptEvidence({...evidence,wrapped:evidence.keys.buyer},buyerKey,id)).toBe("Private receipt 123");
    expect(await decryptEvidence({...evidence,wrapped:evidence.keys.merchant},merchantKey,id)).toBe("Private receipt 123");
    await expect(decryptEvidence({...evidence,wrapped:evidence.keys.buyer},merchantKey,id)).rejects.toThrow();
    await expect(decryptEvidence({...evidence,wrapped:evidence.keys.buyer},buyerKey,"0".repeat(64))).rejects.toThrow("commitment");
  });
});
