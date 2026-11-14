import {decode,openEvidenceWithExcerptKey} from "../evidence-crypto";
import {resolutionAssessmentDigest} from "./assessment-digest.mjs";
import {verifyEvidenceManifest} from "./evidence-manifest";
import type {AuthorizedResolutionProof} from "./proof";

export async function verifyPrivateFields({proposal:p,authorized}:AuthorizedResolutionProof) {
  const checks:{name:string;status:"Passed"|"Failed"|"Unavailable";detail?:string}[]=[];
  if (!authorized) return checks;
  const {manifest,openings}=authorized;
  try {
    if (!Array.isArray(manifest) || !manifest.every(entry=>entry.author===p.buyer || entry.author===p.merchant) ||
      await verifyEvidenceManifest({network:p.network,escrow:p.escrow,booking:p.booking,position:Number(p.position)},manifest)!==p.evidenceRoot) {
      throw Error("Evidence does not match the signed snapshot.");
    }
  } catch {
    return [{name:"evidenceSnapshot",status:"Failed" as const,detail:"The manifest does not match the signed snapshot."}];
  }
  checks.push({name:"evidenceSnapshot",status:"Passed"});
  const terms=manifest.some(entry=>entry.kind==="agreement_terms" && entry.ciphertextHash===p.privateTermsCommitment);
  checks.push({name:"privateTermsCommitment",status:terms?"Passed":"Failed"});
  const entries=new Map(manifest.map(entry=>[entry.entryHash,entry]));
  const seen=new Set<string>();
  try {
    if (!Array.isArray(openings)) throw Error("Invalid openings.");
    for (const opening of openings) {
      const entry=entries.get(opening.entryHash);
      if (!entry || seen.has(opening.entryHash) ||
        await openEvidenceWithExcerptKey(opening,entry.ciphertextHash)!==opening.text) {
        throw Error("Invalid opening.");
      }
      seen.add(opening.entryHash);
    }
    checks.push({name:"evidencePlaintext",status:seen.size===entries.size?"Passed":"Unavailable",
      detail:`${seen.size} of ${entries.size} excerpts verified on this device.`});
  } catch {
    checks.push({name:"evidencePlaintext",status:"Failed",detail:"An excerpt or its decryption key does not match."});
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
      checks.push({name:"aiTranscript",status:"Failed",detail:"The encrypted transcript does not match the signed agreement."});
      return checks;
    }
    try {
      const sdk=await import("@nearai/inference-sdk");
      const attestation=await sdk.verifyModelAttestation({attestation:transcript.attestation,
        clientBinding:{nonce:transcript.attestation.nonce},
        verifiers:{gpuEvidence:sdk.createGpuEvidenceVerifier({nrasUrl:new URL("/api/near-nras",location.origin).href})}});
      try {
        sdk.verifyModelResponse({requestBody,responseBody,signature:transcript.signature,attestation});
        checks.push({name:"aiTranscript",status:"Passed",detail:"The signature covers the encrypted request and response."});
      } catch {
        checks.push({name:"aiTranscript",status:"Failed",detail:"The model signature does not authenticate the encrypted transcript."});
      }
    } catch {
      checks.push({name:"aiTranscript",status:"Unavailable",detail:"The signed transcript could not be verified on this device."});
    }
  }
  return checks;
}
