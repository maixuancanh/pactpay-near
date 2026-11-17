import {expect, it} from "vitest";
import {nextResolutionAction} from "./next-action";
import type {AgreementRecord} from "./chain-v2";

const agreement = {
  status: "Active", approvals: 3,
  proposal: {deliverBy: "20", reviewUntil: "30"},
} as AgreementRecord;

it("stops asking the merchant to submit evidence when the delivery deadline passes", () => {
  const input = {account:"merchant.testnet", open:true, proposed:false, agreement,
    buyer:false, merchant:true, canPropose:false};
  expect(nextResolutionAction({...input,time:19})).toContain("submit the selected evidence");
  expect(nextResolutionAction({...input,time:20})).toContain("completion deadline passed");
  expect(nextResolutionAction({...input,time:30})).toBe("Apply the signed deadline split.");
});

it("does not present the merchant's obligation to an unrelated wallet", () => {
  expect(nextResolutionAction({account:"viewer.testnet",open:true,proposed:false,agreement,
    buyer:false,merchant:false,time:19,canPropose:false})).toBeNull();
});
