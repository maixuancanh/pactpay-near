interface HistoryScope {
  network: "testnet";
  escrow: string;
  booking: string;
  position: string;
  version: string;
}

export interface IndexedReference {
  scope: HistoryScope;
  transactionHash: string;
  signer: string;
  receiptIds: string[];
  blockHash: string;
  blockHeight: string;
  kind: "proposal" | "approval" | "completion" | "allocation" | "claim";
  observedAt: string;
  claimId?: string;
  digest?: string;
}

interface HistoryPage {
  references: IndexedReference[];
  coverage: "partial";
  nextCursor: string | null;
}

type WalletReference = {hash: string; sender: string; method: string};
const supported = new Set(["propose_agreement","approve_agreement","submit_completion","object_agreement",
  "confirm_agreement_completion","settle_agreement","claim_v2","claim_retryable_v2"]);
const active = new Set<string>();

export async function readCaseHistory(scope: HistoryScope, cursor?: string, signal?: AbortSignal): Promise<HistoryPage> {
  const params = new URLSearchParams({...scope});
  if (cursor) params.set("cursor",cursor);
  const response = await fetch("/api/near-case-index?"+params.toString(),{signal:signal ?? AbortSignal.timeout(20000)});
  if (!response.ok) throw new Error("Receipt history unavailable.");
  return response.json();
}

async function submitReference(key: string, ref: WalletReference) {
  if (active.has(key)) return;
  active.add(key);
  try {
    const response = await fetch("/api/near-case-index",{
      method:"POST",headers:{"content-type":"application/json"},
      body:JSON.stringify({hash:ref.hash,signer:ref.sender}),signal:AbortSignal.timeout(20000),
    });
    if (response.status === 200 || response.status === 422) {
      localStorage.removeItem(key);
      if (response.ok) window.dispatchEvent(new Event("pactpay:case-indexed"));
    }
  } catch {
    // Retain the reference when the API or RPC is temporarily unreachable.
  } finally {
    active.delete(key);
  }
}

const queuePrefix = (escrow: string) => "pactpay:case-index:testnet:"+escrow+":";

export function queueCaseReference(escrow: string, ref: WalletReference) {
  if (!supported.has(ref.method)) return;
  const key = queuePrefix(escrow)+ref.hash;
  try { localStorage.setItem(key,JSON.stringify(ref)); }
  catch { /* An unavailable local queue must not interrupt a wallet transaction. */ }
  void submitReference(key,ref);
}

export async function retryCaseReferences(escrow: string) {
  try {
    const prefix = queuePrefix(escrow);
    const keys = Object.keys(localStorage).filter(key => key.startsWith(prefix)).slice(0,4);
    for (const key of keys) {
      const ref: WalletReference = JSON.parse(localStorage.getItem(key) ?? "null");
      if (ref && supported.has(ref.method)) await submitReference(key,ref);
    }
  } catch {
    // Storage can be disabled by the browser.
  }
}
