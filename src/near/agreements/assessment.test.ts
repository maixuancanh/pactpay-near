import {expect, test} from "vitest";
import {parseAssessment} from "./assessment";

const sources = [{id:"source-a", paragraphs:["Received six items", "Invoice lists eight items"]}];
const finding = {text:"Possible discrepancy", citations:[{sourceId:"source-a", paragraph:1, excerpt:"six items"}]};
function parse(revision: unknown, available = sources) {
  return parseAssessment(JSON.stringify(revision), available);
}
const output = {claims:[finding], conflictingClaims:[], missingFacts:[], suggestedRemedy:null};
test("checks an exact excerpt in a numbered paragraph", () => {
  expect(parse(output).claims[0].supported).toBe(true);
});
test.each([
  ["fabricated excerpt", {excerpt:"seven items"}],
  ["wrong source", {sourceId:"source-b"}],
  ["wrong paragraph", {paragraph:2}],
  ["OCR digit mismatch", {excerpt:"6 items"}],
  ["blank excerpt", {excerpt:" "}],
])("flags %s", (_label, patch) => {
  expect(parse({...output, claims:[{...finding, citations:[{...finding.citations[0], ...patch}]}]}).claims[0].supported).toBe(false);
});
test("flags absent source", () => expect(parse(output, []).claims[0].supported).toBe(false));
test("keeps conflicting claims and missing facts distinct", () => {
  expect(parse({...output, conflictingClaims:[finding], missingFacts:["Delivery time"]}).missingFacts).toEqual(["Delivery time"]);
});
test("rejects HTML and injected payment fields", () => {
  expect(() => parse({...output, suggestedRemedy:"<script>pay()</script>"})).toThrow();
  expect(() => parse({...output, recipient:"attacker.testnet"})).toThrow();
});
test("rejects malformed responses", () => {
  expect(() => parseAssessment("AI unavailable", sources)).toThrow();
});
test("accepts a single JSON fence but rejects surrounding commentary", () => {
  const fenced = "```json\n" + JSON.stringify(output) + "\n```";
  expect(parseAssessment(fenced, sources).claims[0].supported).toBe(true);
  expect(() => parseAssessment("Commentary\n" + fenced, sources)).toThrow();
});

test("binds an assessment digest to its case, revision and exact encrypted transcript", async () => {
  const {resolutionAssessmentDigest} = await import("./assessment-digest.mjs");
  const scope = {network:"testnet" as const,escrow:"escrow.testnet",booking:"1",position:"0",version:"1",
    termsCommitment:"1".repeat(64),evidenceRoot:"2".repeat(64)};
  const material = {model:"synthetic",promptVersion:"1",inputHash:"3".repeat(64),outputHash:"4".repeat(64),
    proof:{request:"YWJj",response:"ZGVm"}};
  const original = await resolutionAssessmentDigest(scope,material);
  expect(original).not.toBe(await resolutionAssessmentDigest({...scope,version:"2"},material));
  expect(original).not.toBe(await resolutionAssessmentDigest({...scope,booking:"2"},material));
  expect(original).not.toBe(await resolutionAssessmentDigest(scope,{...material,proof:{...material.proof,request:"bmV3"}}));
});
