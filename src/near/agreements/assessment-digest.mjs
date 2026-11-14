export async function resolutionAssessmentDigest(scope, material) {
  const {model,promptVersion,inputHash,outputHash,proof} = material;
  const hash = async value => {
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
    return Array.from(new Uint8Array(digest),byte => byte.toString(16).padStart(2,"0")).join("");
  };
  const [requestHash,responseHash] = await Promise.all([hash(proof.request),hash(proof.response)]);
  return hash(JSON.stringify([
    "pactpay.assessment.v2",scope.network,scope.escrow,scope.booking,scope.position,scope.version,
    scope.evidenceRoot,scope.termsCommitment,promptVersion,model,inputHash,outputHash,
    requestHash,responseHash,"encrypted-transcript-verified","unavailable",
  ]));
}
