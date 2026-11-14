export interface AgreementV2 {
  schema: "pactpay.resolution.v2";
  network: "testnet";
  escrow: string;
  booking: string;
  position: string;
  version: string;
  buyer: string;
  merchant: string;
  token: string;
  termsCommitment: string;
  evidenceRoot: string;
  privateTermsCommitment: string;
  assessmentDigest: string | null;
  immediateBuyer: string;
  immediateMerchant: string;
  retained: string;
  successBuyer: string;
  successMerchant: string;
  fallbackBuyer: string;
  fallbackMerchant: string;
  acceptBy: string;
  deliverBy: string;
  reviewUntil: string;
  salt: string;
}
