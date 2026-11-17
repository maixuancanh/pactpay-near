import type {CaseCheckResult,CaseScope} from "../src/near/agreements/case-model";

export interface SourceReceipt {
  entryHash:string;
  signature:string;
  payload:{
    schema:"pactpay.delivery-source.v1";
    eventType:"access-granted";
    issuer:string;
    keyId:string;
    eventId:string;
    scope:CaseScope;
    artifactDigest:string;
    recipient:string;
    occurredAt:number;
    expiresAt:number;
  };
}
export type SourceIssuer = {id:string;keyId:string;label:string;publicKey:string};
export function copySourceReceipt(receipt:unknown):SourceReceipt;
export function sourceReceiptMessage(payload:SourceReceipt["payload"],entryHash:string):Uint8Array;
export function trustedSourceIssuers(configuration:string|undefined):SourceIssuer[];
export function verifySourceReceipt(input:{
  receipt:SourceReceipt|undefined; scope:CaseScope; recipient:string;
  openings:ReadonlyMap<string,string>; issuers:readonly SourceIssuer[]; now?:number;
}):Promise<CaseCheckResult>;
