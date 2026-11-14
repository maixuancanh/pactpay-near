import type {AgreementV2} from "./types";
export function canonicalAgreement(p: AgreementV2): string;
export function agreementDigest(p: AgreementV2): Promise<string>;
