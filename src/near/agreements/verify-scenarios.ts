import type {AuthorizedResolutionProof,ResolutionProof} from "./proof";
import type {VerificationCheck} from "./case-model";

export const scenarios = [
  {id:"amount",label:"Change payout amount"},
  {id:"recipient",label:"Change merchant recipient"},
  {id:"booking",label:"Use another booking's approval"},
  {id:"evidence-root",label:"Change evidence snapshot"},
  {id:"approval",label:"Remove one approval"},
  {id:"nonce",label:"Replace attestation nonce"},
  {id:"duplicate",label:"Repeat a payout receipt"},
] as const;
export type ScenarioId = typeof scenarios[number]["id"];
export type InspectableProof = ResolutionProof & {authorized?:AuthorizedResolutionProof["authorized"]};
export type Mutation = {proof:InspectableProof;id:ScenarioId;field:string;before:unknown;after:unknown;expectedCheck:string};
const changedHex=(value:string)=> (value[0]==="0" ? "1" : "0")+value.slice(1);

/** Only edits a detached copy. Never generates signatures or sends transactions. */
export function mutateProof(original:InspectableProof,id:ScenarioId,foreign?:InspectableProof):Mutation {
  const proof=structuredClone(original);
  let field:string, before:unknown, after:unknown, expectedCheck:string;
  const p=proof.proposal;
  switch(id){
    case "amount":
      field="proposal.immediateMerchant";before=p.immediateMerchant;after=p.immediateMerchant=(BigInt(p.immediateMerchant)+1n).toString();expectedCheck="agreementDigest";break;
    case "recipient":
      field="proposal.merchant";before=p.merchant;after=p.merchant=p.merchant==="changed-recipient.testnet" ? "other-recipient.testnet" : "changed-recipient.testnet";expectedCheck="agreementDigest";break;
    case "evidence-root":
      field="proposal.evidenceRoot";before=p.evidenceRoot;after=p.evidenceRoot=changedHex(p.evidenceRoot);expectedCheck="agreementDigest";break;
    case "booking":
      if(!foreign?.receipts.approval || foreign.proposal.booking===p.booking) throw Error("A different booking's approval is required.");
      field="receipts.approval";before=proof.receipts.approval;after=proof.receipts.approval=structuredClone(foreign.receipts.approval);expectedCheck="bilateralApproval";break;
    case "approval":
      field="receipts.approval";before=proof.receipts.approval;delete proof.receipts.approval;after="Omitted";expectedCheck="bilateralApproval";break;
    case "nonce": {
      const transcript=proof.authorized?.transcript;
      if(!transcript?.expectedAttestationNonce || !transcript.attestation?.nonce) throw Error("A transcript with a committed challenge is required.");
      field="authorized.transcript.attestation.nonce";before=transcript.attestation.nonce;after=transcript.attestation.nonce=changedHex(transcript.expectedAttestationNonce);expectedCheck="aiTranscript";break;
    }
    case "duplicate":
      if(!proof.receipts.claims.length) throw Error("A payout receipt is required.");
      field="receipts.claims";before=structuredClone(proof.receipts.claims);proof.receipts.claims.push(structuredClone(proof.receipts.claims[0]));after=proof.receipts.claims;expectedCheck="claimPayments";break;
  }
  return {proof,id,field,before,after,expectedCheck};
}

const coverage=["proofIdentity","agreementDigest","bilateralApproval","contractVersionAndCode","claimPayments",
  "evidenceSnapshot","privateTermsCommitment","evidencePlaintext","evidenceSource","aiTranscript","aiAttestationNonce","aiPlaintextBinding"];
export function verificationOutcome(checks:VerificationCheck[],proof:InspectableProof):"Valid"|"Invalid"|"Incomplete"|"Unavailable" {
  if(checks.some(c=>c.status==="Failed")) return "Invalid";
  if(!checks.length) return "Unavailable";
  const missingMaterial=(name:string)=>
    !["proofIdentity","agreementDigest"].includes(name) && (!proof.receipts.proposal || !proof.receipts.approval) ||
    name==="bilateralApproval" && (!proof.receipts.proposal || !proof.receipts.approval) ||
    name==="claimPayments" && !proof.receipts.claims.length ||
    ["evidenceSnapshot","privateTermsCommitment","evidencePlaintext"].includes(name) && !proof.authorized ||
    name==="evidencePlaintext" && proof.authorized && proof.authorized.openings.length<proof.authorized.manifest.length ||
    name==="evidenceSource" && !proof.authorized?.sourceReceipt ||
    ["aiTranscript","aiAttestationNonce"].includes(name) && !proof.authorized?.transcript ||
    name==="aiAttestationNonce" && !proof.authorized?.transcript?.expectedAttestationNonce ||
    name==="aiPlaintextBinding" ||
    name==="contractVersionAndCode" && (!proof.receipts.proposal || !proof.receipts.approval);
  if(checks.some(c=>c.status==="Unavailable" && !missingMaterial(c.name))) return "Unavailable";
  if(coverage.some(name=>!checks.some(c=>c.name===name && c.status==="Passed"))) return "Incomplete";
  return "Valid";
}
export function scenarioResult(mutation:Mutation,checks:VerificationCheck[]):string {
  const result=checks.find(c=>c.name===mutation.expectedCheck);
  if(mutation.id==="approval") return result?.status==="Unavailable"
    ? "Incomplete: the proof no longer includes both approval references. This is missing evidence, not proof that an approval never happened."
    : "Not demonstrated: missing approval coverage was not reported.";
  return result?.status==="Failed"
    ? `Rejected by ${mutation.expectedCheck}: ${result.detail ?? result.reason ?? "The proof does not match."}`
    : `Not demonstrated: ${mutation.expectedCheck} did not reject this mutation. An unavailable check is not a successful tamper test.`;
}
