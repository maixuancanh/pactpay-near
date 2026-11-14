export interface EvidenceCase {
  network: "testnet";
  escrow: string;
  booking: string;
  position: number;
}
export type EvidenceKind = "evidence" | "agreement_terms" | "completion";
export interface EvidenceEntry {
  case: EvidenceCase;
  author: string;
  sequence: number;
  previousEntryHash: string | null;
  ciphertextHash: string;
  supersedes: string | null;
  sourceLocator: string;
  createdAt: string;
  kind: EvidenceKind;
  entryHash: string;
}
export const evidenceKinds: EvidenceKind[];
export function hashEvidenceEntry(entry: Omit<EvidenceEntry,"entryHash">): Promise<string>;
export function verifyEvidenceManifest(scope: EvidenceCase, entries: readonly EvidenceEntry[]): Promise<string>;
