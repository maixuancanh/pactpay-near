import {createElement} from "react";
import {expect, test} from "vitest";
import {renderToStaticMarkup} from "react-dom/server";
import OutcomePreview from "./OutcomePreview";
import {previewAllocation} from "./outcome-preview";
import type {AgreementV2} from "./types";
import type {AgreementRecord} from "./chain-v2";
import {checkSplit} from "./policy";

const proposal: AgreementV2 = {
  schema:"pactpay.resolution.v2", network:"testnet", escrow:"escrow.testnet", booking:"0", position:"1",
  version:"1", buyer:"buyer.testnet", merchant:"merchant.testnet",token:"token.testnet",
  termsCommitment:"a".repeat(64), evidenceRoot:"a".repeat(64), privateTermsCommitment:"a".repeat(64), assessmentDigest:null,
  immediateBuyer:"0",immediateMerchant:"12",retained:"8",successBuyer:"0",successMerchant:"8",
  fallbackBuyer:"3",fallbackMerchant:"5",acceptBy:"100",deliverBy:"200",reviewUntil:"300",salt:"a".repeat(64),
};
const agreement: AgreementRecord = {proposal,digest:"b".repeat(64),status:"Proposed",approvals:1,
  completion_evidence_root:null,objection_evidence_root:null};

test("20-unit proposal preserves all three allocations, including a partial merchant fallback", () => {
  const immediate = previewAllocation(proposal,"immediate");
  const success = previewAllocation(proposal,"success");
  const fallback = previewAllocation(proposal,"fallback");
  expect(immediate).toEqual({buyer:"0",merchant:"12",retained:"8"});
  expect(success).toEqual({buyer:"0",merchant:"8",retained:"0"});
  expect(fallback).toEqual({buyer:"3",merchant:"5",retained:"0"});
  expect(checkSplit("20",immediate.buyer,immediate.merchant,immediate.retained)).toBe(true);
  for (const branch of [success,fallback]) expect(checkSplit("8",branch.buyer,branch.merchant,branch.retained)).toBe(true);
});

test("keeps exact amounts above the JavaScript safe integer limit and accepts zero allocations", () => {
  const large = {...proposal,immediateMerchant:"900719925474099312345",fallbackBuyer:"0",fallbackMerchant:"8"};
  expect(previewAllocation(large,"immediate").merchant).toBe("900719925474099312345");
  expect(previewAllocation(large,"fallback")).toEqual({buyer:"0",merchant:"8",retained:"0"});
});

test.each(["Completed","FallbackAllocated"] as const)("%s is historical, never presented as another settlement", status => {
  const html = renderToStaticMarkup(createElement(OutcomePreview,{agreement:{...agreement,status},account:"viewer.testnet",time:301}));
  expect(html).toContain("cannot be settled again");
  expect(html).toContain("Allocation does not mean payment has been received");
  expect(html).toContain("Browsing does not sign or move funds");
  expect((html.match(/<button/g) || []).length).toBe(3);
});

test("expires at the exact chain acceptance deadline and displays proposal identity", () => {
  const render = (time:number) => renderToStaticMarkup(createElement(OutcomePreview,{agreement,account:"",time}));
  expect(render(99)).not.toContain("This proposal has expired");
  expect(render(100)).toContain("This proposal has expired");
  expect(render(100)).toContain(agreement.digest);
  expect(render(100)).toContain("No wallet connected");
});
