import {describe, it, expect} from "vitest";
import {Resolution, validateResolution, resolutionPayload} from "./resolution";

const proposal: Resolution = {
  network: "testnet", contract: "escrow.testnet", booking: "booking-1",
  position: "buyer-1", termsRevision: 1, evidenceRevision: 2, nonce: "1",
  merchant: "merchant.testnet", buyer: "buyer.testnet", token: "demo.testnet",
  refund: "8", payout: "12", expiresAt: 200,
};

describe("NEAR resolution proposals", () => {
  it("allocates exactly the disputed share", () => {
    expect(() => validateResolution(proposal, "20", 1, 2, 100)).not.toThrow();
    expect(() => validateResolution({...proposal, payout: "13"}, "20", 1, 2, 100)).toThrow();
  });
  it("rejects stale evidence and the expiry boundary", () => {
    expect(() => validateResolution(proposal, "20", 1, 3, 100)).toThrow("Stale");
    expect(() => validateResolution(proposal, "20", 1, 2, 200)).toThrow("expired");
  });
  it("preserves integer precision above the JavaScript safe integer limit", () => {
    expect(() => validateResolution({...proposal, payout: "9007199254740993"},
      "9007199254741001", 1, 2, 100)).not.toThrow();
  });
  it("rejects negative and non-canonical amounts", () => {
    for (const refund of ["-1", "1.5", "08", "1e2"]) {
      expect(() => validateResolution({...proposal, refund}, "20", 1, 2, 100)).toThrow();
    }
  });
  it("binds approvals to recipients, contract and evidence revision", () => {
    const original = resolutionPayload(proposal);
    for (const updated of [
      {...proposal, buyer: "other.testnet"},
      {...proposal, contract: "other.testnet"},
      {...proposal, evidenceRevision: 3},
    ]) expect(resolutionPayload(updated)).not.toBe(original);
  });
});
