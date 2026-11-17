import {decode,openEvidenceWithExcerptKey} from "../evidence-crypto";
import {resolutionAssessmentDigest} from "./assessment-digest.mjs";
import {verifyEvidenceManifest} from "./evidence-manifest";
import type {AuthorizedResolutionProof} from "./proof";
import type {VerificationCheck} from "./case-model";
import {trustedSourceIssuers,verifySourceReceipt} from "../../../lib/near-source-proof.mjs";

export async function verifyPrivateFields({proposal:p,authorized}:AuthorizedResolutionProof):Promise<VerificationCheck[]> {
  const checks:VerificationCheck[]=[
    {name:"evidenceSource",status:"Unavailable",reason:"source-attestation-missing",
      detail:"The evidence snapshot does not authenticate the issuer of an excerpt."},
    {name:"aiPlaintextBinding",status:"Unavailable",reason:"plaintext-binding-missing",
      detail:"The proof does not bind the original text to the model's signed response."},
  ];
  if (!authorized) return checks;
  const {manifest,openings}=authorized;
  try {
    if (!Array.isArray(manifest) || !manifest.every(entry=>entry.author===p.buyer || entry.author===p.merchant) ||
      await verifyEvidenceManifest({network:p.network,escrow:p.escrow,booking:p.booking,position:Number(p.position)},manifest)!==p.evidenceRoot) {
      throw Error("Evidence does not match the signed snapshot.");
    }
  } catch {
    return [...checks,{name:"evidenceSnapshot",status:"Failed",reason:"manifest-mismatch",
      detail:"The manifest does not match the signed snapshot."}];
  }
  checks.push({name:"evidenceSnapshot",status:"Passed",reason:"manifest-root-matches"});
  const terms=manifest.some(entry=>entry.kind==="agreement_terms" && entry.ciphertextHash===p.privateTermsCommitment);
  checks.push({name:"privateTermsCommitment",status:terms?"Passed":"Failed",
    reason:terms?"terms-ciphertext-matches":"terms-ciphertext-missing"});
  const entries=new Map(manifest.map(entry=>[entry.entryHash,entry]));
  const opened=new Map<string,string>();
  try {
    if (!Array.isArray(openings)) throw Error("Invalid openings.");
    for (const opening of openings) {
      const entry=entries.get(opening.entryHash);
      if (!entry || opened.has(opening.entryHash) ||
        await openEvidenceWithExcerptKey(opening,entry.ciphertextHash)!==opening.text) {
        throw Error("Invalid opening.");
      }
      opened.set(opening.entryHash,opening.text);
    }
    checks.push({name:"evidencePlaintext",status:opened.size===entries.size?"Passed":"Unavailable",
      reason:opened.size===entries.size?"openings-verified":"openings-incomplete",
      detail:`${opened.size} of ${entries.size} excerpts verified on this device.`});
  } catch {
    opened.clear();
    checks.push({name:"evidencePlaintext",status:"Failed",reason:"opening-mismatch",detail:"An excerpt or its decryption key does not match."});
  }
  if (authorized.sourceReceipt) {
    const {network,escrow,booking,position,version} = p;
    const source = await verifySourceReceipt({receipt:authorized.sourceReceipt,
      scope:{network,escrow,booking,position,version},recipient:p.buyer,openings:opened,
      issuers:trustedSourceIssuers(import.meta.env.VITE_NEAR_SOURCE_ISSUERS)});
    const statuses={verified:"Passed",invalid:"Failed",unavailable:"Unavailable"} as const;
    checks[0]={name:"evidenceSource",status:statuses[source.state],
      reason:source.reason,detail:source.detail};
  }
  if (!p.assessmentDigest || !authorized.transcript) {
    return [...checks,{name:"aiTranscript",status:"Unavailable",reason:"signed-transcript-missing"}];
  }
  if (p.assessmentDigest && authorized.transcript) {
    const transcript=authorized.transcript;
    let requestBody, responseBody;
    try {
      requestBody=decode(transcript.request);responseBody=decode(transcript.response);
      if (transcript.version!==1 || transcript.signature?.kind!=="provider_tee" ||
        JSON.parse(new TextDecoder().decode(responseBody)).id!==transcript.id ||
        await resolutionAssessmentDigest(p,{...transcript,proof:transcript})!==p.assessmentDigest) {
        throw Error("Transcript commitment mismatch");
      }
    } catch {
      checks.push({name:"aiTranscript",status:"Failed",reason:"transcript-commitment-mismatch",
        detail:"The encrypted transcript does not match the signed agreement."});
      return checks;
    }
    try {
      const sdk=await import("@nearai/inference-sdk");
      const attestation=await sdk.verifyModelAttestation({attestation:transcript.attestation,
        clientBinding:{nonce:transcript.attestation.nonce},
        verifiers:{gpuEvidence:sdk.createGpuEvidenceVerifier({nrasUrl:new URL("/api/near-nras",location.origin).href})}});
      try {
        sdk.verifyModelResponse({requestBody,responseBody,signature:transcript.signature,attestation});
        checks.push({name:"aiTranscript",status:"Passed",reason:"model-signature-verified",
          detail:"The signature covers the encrypted request and response."});
      } catch {
        checks.push({name:"aiTranscript",status:"Failed",reason:"model-signature-invalid",
          detail:"The model signature does not authenticate the encrypted transcript."});
      }
    } catch {
      checks.push({name:"aiTranscript",status:"Unavailable",reason:"model-attestation-unverified",
        detail:"The signed transcript could not be verified on this device."});
    }
  }
  return checks;
}
