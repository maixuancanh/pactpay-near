import {expect, it} from "vitest";
import {invitationUrl, needsInvitationReview, parseInvitation} from "./invitation";

const scope = {escrow: "escrow.testnet", booking: 2, position: 1, version: "3"};
const url = () => new URL(invitationUrl("https://pactpay.example", scope));

it("opens the exact invitation scope without embedding credentials or outside URLs", () => {
  expect(url().pathname).toBe("/booking");
  expect([...url().searchParams.keys()]).toEqual(["escrow", "booking", "position", "version"]);
  expect(parseInvitation(url().searchParams, [scope.escrow])).toEqual(scope);
  expect(parseInvitation(new URLSearchParams("booking=2"), [scope.escrow])).toBeNull();
});

it("requires explicit review when the current agreement changes again", () => {
  expect(needsInvitationReview("3", "3", undefined)).toBe(false);
  expect(needsInvitationReview("3", "4", undefined)).toBe(true);
  expect(needsInvitationReview("3", "4", "4")).toBe(false);
  expect(needsInvitationReview("3", "5", "4")).toBe(true);
});

it("rejects unknown escrows, duplicate keys and malformed scope", () => {
  expect(() => parseInvitation(url().searchParams, ["elsewhere.testnet"])).toThrow();
  for (const [key, value] of [["booking", "-1"], ["position", "9007199254740992"], ["version", "18446744073709551616"]]) {
    const params = url().searchParams;
    params.set(key, value);
    expect(() => parseInvitation(params, [scope.escrow])).toThrow();
  }
  const params = url().searchParams;
  params.append("booking", "2");
  expect(() => parseInvitation(params, [scope.escrow])).toThrow();
});
