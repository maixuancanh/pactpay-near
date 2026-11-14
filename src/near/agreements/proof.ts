import type {AgreementV2} from "./types";

export interface ResolutionTransactionReference {
  hash: string;
  signer: string;
}

export interface ResolutionProof {
  schema: "pactpay.resolution-proof.v2";
  network: "testnet";
  escrow: string;
  contractVersion: 2;
  codeHash: string;
  proposal: AgreementV2;
  digest: string;
  receipts: {
    proposal?: ResolutionTransactionReference;
    approval?: ResolutionTransactionReference;
    claims: (ResolutionTransactionReference & {reconciliation?: ResolutionTransactionReference})[];
  };
}

/** Copies the public agreement fields and wallet transaction references only. */
export function publicResolutionProof(input: Omit<ResolutionProof,"schema"|"network"|"escrow"|"contractVersion">): ResolutionProof {
  const {
    schema, network, escrow, booking, position, version, buyer, merchant, token,
    termsCommitment, evidenceRoot, privateTermsCommitment, assessmentDigest,
    immediateBuyer, immediateMerchant, retained, successBuyer, successMerchant,
    fallbackBuyer, fallbackMerchant, acceptBy, deliverBy, reviewUntil, salt,
  } = input.proposal;
  const reference = ({hash, signer}: ResolutionTransactionReference) => ({hash, signer});
  return {
    schema:"pactpay.resolution-proof.v2", network, escrow, contractVersion:2,
    codeHash:input.codeHash, digest:input.digest,
    proposal:{
      schema, network, escrow, booking, position, version, buyer, merchant, token,
      termsCommitment, evidenceRoot, privateTermsCommitment, assessmentDigest,
      immediateBuyer, immediateMerchant, retained, successBuyer, successMerchant,
      fallbackBuyer, fallbackMerchant, acceptBy, deliverBy, reviewUntil, salt,
    },
    receipts:{
      proposal:input.receipts.proposal && reference(input.receipts.proposal),
      approval:input.receipts.approval && reference(input.receipts.approval),
      claims:input.receipts.claims.map(claim => ({
        ...reference(claim),
        ...(claim.reconciliation ? {reconciliation:reference(claim.reconciliation)} : {}),
      })),
    },
  };
}

export interface ResolutionEvidenceOpening {
  entryHash: string;
  iv: string;
  ciphertext: string;
  excerptKey: string;
  text: string;
}

type AssessmentResult = Awaited<ReturnType<typeof import("../claimguard").analyzeResolutionEvidence>>;
export type ResolutionTranscript = AssessmentResult["proof"] &
  Pick<AssessmentResult,"id"|"model"|"promptVersion"|"inputHash"|"outputHash">;

export interface AuthorizedResolutionProof extends ResolutionProof {
  authorized: {
    manifest: import("./evidence-manifest").EvidenceEntry[];
    openings: ResolutionEvidenceOpening[];
    transcript?: ResolutionTranscript;
  };
}

export function authorizedResolutionProof(
  publicProof: ResolutionProof,
  {manifest, openings, transcript}: AuthorizedResolutionProof["authorized"],
  consent: boolean,
): AuthorizedResolutionProof {
  if (!consent) throw new Error("Confirm disclosure of the selected evidence and its excerpt keys.");
  return {
    ...publicResolutionProof(publicProof),
    authorized:{
      manifest:manifest.map(({case:scope,author,sequence,previousEntryHash,ciphertextHash,supersedes,sourceLocator,createdAt,kind,entryHash}) => ({
        case:{network:scope.network,escrow:scope.escrow,booking:scope.booking,position:scope.position},
        author,sequence,previousEntryHash,ciphertextHash,supersedes,sourceLocator,createdAt,kind,entryHash,
      })),
      openings:openings.map(({entryHash,iv,ciphertext,excerptKey,text}) => ({entryHash,iv,ciphertext,excerptKey,text})),
      transcript:transcript && {
        id:transcript.id,version:transcript.version,model:transcript.model,promptVersion:transcript.promptVersion,
        inputHash:transcript.inputHash,outputHash:transcript.outputHash,request:transcript.request,response:transcript.response,
        signature:transcript.signature,attestation:transcript.attestation,
      },
    },
  };
}
