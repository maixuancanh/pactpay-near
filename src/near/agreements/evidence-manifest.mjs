const encoder = new TextEncoder();
const hashPattern = /^[a-f0-9]{64}$/;
const accountPattern = /^[a-z0-9]+(?:[._-][a-z0-9]+)*$/;
export const evidenceKinds = ["evidence", "agreement_terms", "completion"];

async function hash(value) {
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(JSON.stringify(value)));
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2,"0")).join("");
}

function caseTuple(scope) {
  return [scope.network,scope.escrow,scope.booking,scope.position];
}

export function hashEvidenceEntry(entry) {
  return hash(["PACTPAY_EVIDENCE_ENTRY_V2",...caseTuple(entry.case),entry.author,entry.sequence,
    entry.previousEntryHash,entry.ciphertextHash,entry.supersedes,entry.sourceLocator,entry.createdAt,entry.kind]);
}

export async function verifyEvidenceManifest(scope, entries) {
  const expected = JSON.stringify(caseTuple(scope));
  const chains = new Map();
  const ordered = [...entries].sort((a,b)=>a.author < b.author ? -1 : a.author > b.author ? 1 : a.sequence-b.sequence);
  for (const entry of ordered) {
    if (JSON.stringify(caseTuple(entry.case)) !== expected || typeof entry.author !== "string" ||
        entry.author.length < 2 || entry.author.length > 64 || !accountPattern.test(entry.author) ||
        !hashPattern.test(entry.ciphertextHash) || !hashPattern.test(entry.entryHash) ||
        !evidenceKinds.includes(entry.kind) || entry.sourceLocator !== entry.author+"/entries/"+entry.sequence ||
        !/^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$/.test(entry.createdAt)) {
      throw new Error("Invalid evidence manifest entry.");
    }
    const prior = chains.get(entry.author) ?? {sequence:0,head:null,entries:new Set()};
    if (entry.sequence !== prior.sequence+1 || entry.previousEntryHash !== prior.head ||
        (entry.supersedes !== null && !prior.entries.has(entry.supersedes)) ||
        await hashEvidenceEntry(entry) !== entry.entryHash) {
      throw new Error("Invalid evidence manifest continuity.");
    }
    prior.sequence=entry.sequence;
    prior.head=entry.entryHash;
    prior.entries.add(entry.entryHash);
    chains.set(entry.author,prior);
  }
  return hash(["PACTPAY_EVIDENCE_SNAPSHOT_V2",...caseTuple(scope),ordered.map(entry=>entry.entryHash)]);
}
