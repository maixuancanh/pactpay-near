export type CaseScope = {
  network: "testnet";
  escrow: string;
  booking: string;
  position: string;
  version: string;
};

export type CheckState = "verified" | "unavailable" | "invalid";
export type CaseCheckResult = {state: CheckState; reason: string; detail?: string};
export type CaseChecks<T = CheckState> = Record<
  "commitment" | "source" | "encryptedTranscript" | "plaintextBinding" | "approval" | "payout",
  T
>;

export type ChainReference = {
  scope: CaseScope;
  transactionHash: string;
  signer: string;
  receiptIds: string[];
  blockHash: string;
  blockHeight: string;
  kind: "proposal" | "approval" | "completion" | "allocation" | "claim";
  observedAt: string;
};

const accountId = /^[a-z0-9]+(?:[._-][a-z0-9]+)*$/;
const unsignedInteger = /^(?:0|[1-9][0-9]*)$/;

export function scopeKey(scope: CaseScope): string {
  if (scope.network !== "testnet") throw new Error("Unsupported case network.");
  if (typeof scope.escrow !== "string" || scope.escrow.length < 2 || scope.escrow.length > 64 ||
      !accountId.test(scope.escrow)) throw new Error("Invalid case escrow.");
  for (const field of ["booking", "position", "version"] as const) {
    if (typeof scope[field] !== "string" || !unsignedInteger.test(scope[field])) {
      throw new Error(`Invalid case ${field}.`);
    }
  }
  return JSON.stringify([scope.network, scope.escrow, scope.booking, scope.position, scope.version]);
}

export type VerificationCheck = {
  name: string;
  status: "Passed" | "Failed" | "Unavailable";
  reason?: string;
  detail?: string;
};

function result(check: VerificationCheck | undefined): CaseCheckResult {
  if (!check) return {state: "unavailable", reason: "check-not-performed"};
  const state:CheckState = check.status === "Passed" ? "verified" :
    check.status === "Failed" ? "invalid" : "unavailable";
  return {
    state,
    reason: check.reason ?? `${check.name}-${state}`,
    detail: check.detail,
  };
}

/** Convert results from trusted verifiers, never from the proof file itself. */
export function summarizeCaseChecks(checks: readonly VerificationCheck[]): CaseChecks<CaseCheckResult> {
  const find = (name: string) => result(checks.find(check => check.name === name));
  return {
    commitment: find("evidenceSnapshot"),
    source: find("evidenceSource"),
    encryptedTranscript: find("aiTranscript"),
    plaintextBinding: find("aiPlaintextBinding"),
    approval: find("bilateralApproval"),
    payout: find("claimPayments"),
  };
}
