import type {AgreementV2} from "./types";
export type AssessmentCase = Pick<AgreementV2,"network"|"escrow"|"booking"|"position"|"version"|"evidenceRoot"|"termsCommitment">;
export interface AssessmentDigestMaterial {
  model: string;
  promptVersion: string;
  inputHash: string;
  outputHash: string;
  proof: {request:string; response:string};
}
export function resolutionAssessmentDigest(scope: AssessmentCase, material: AssessmentDigestMaterial): Promise<string>;
