export type Claim = "Unclaimed" | "Pending" | "Paid";
export type Remedy = {
  commitment: string; revision: string; due: string; refund: string; payout: string;
  approvals: number; completed: boolean;
};
export interface Position {
  buyer: string;
  share: string;
  accepted: boolean;
  funded: boolean;
  dispute_until: string | null;
  extended: boolean;
  extension_approvals: number;
  evidence_revision: string;
  evidence_commitment: string | null;
  proposal_version: string;
  proposal: { refund: string; payout: string; expires: string; approvals: number } | null;
  allocation: [string, string] | null;
  has_allocation?: boolean;
  claims: [Claim, Claim];
}
export interface Booking {
  merchant: string;
  terms_commitment: string;
  fund_until: string;
  service_end: string;
  captured: boolean;
  positions: Position[];
}

export const rpcUrl = import.meta.env.VITE_NEAR_RPC || "https://test.rpc.fastnear.com";
export const escrow = import.meta.env.VITE_NEAR_ESCROW?.trim() || "";
export const DAY = 86400;

async function rpc<T>(method: string, params: Record<string, unknown>): Promise<T> {
  const response = await fetch(rpcUrl, {
    method: "POST",
    headers: {"Content-Type": "application/json"},
    body: JSON.stringify({jsonrpc: "2.0", id: "pactpay", method, params}),
    signal: AbortSignal.timeout(12000),
  });
  if (!response.ok) throw new Error("NEAR RPC unavailable");
  const data = await response.json() as {result?: T; error?: {message?: string}};
  if (data.result === undefined) throw new Error(data.error?.message || "NEAR RPC returned no result");
  return data.result;
}

export async function view<T>(account: string, method: string, args = {}): Promise<T> {
  const encoded = btoa(Array.from(new TextEncoder().encode(JSON.stringify(args)), b => String.fromCharCode(b)).join(""));
  const result = await rpc<{result: number[]}>("query", {
    request_type: "call_function", finality: "final", account_id: account,
    method_name: method, args_base64: encoded,
  });
  return JSON.parse(new TextDecoder().decode(Uint8Array.from(result.result))) as T;
}

export async function chainTime(): Promise<number> {
  const block = await rpc<{header: {timestamp_nanosec: string}}>("block", {finality: "final"});
  return Number(BigInt(block.header.timestamp_nanosec) / 1000000000n);
}

export async function finalTransaction(hash: string, sender: string) {
  return rpc<{status?: {Failure?: unknown; SuccessValue?: string}}>("tx", {
    tx_hash: hash, sender_account_id: sender, wait_until: "FINAL",
  });
}

export function parseBookingId(value: string): number {
  if (!/^(0|[1-9]\d*)$/.test(value) || !Number.isSafeInteger(Number(value))) throw new Error("Enter a valid booking ID");
  return Number(value);
}

export async function commitment(value: string): Promise<string> {
  if (!value.trim()) throw new Error("Enter the agreed terms first");
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(bytes), byte => byte.toString(16).padStart(2, "0")).join("");
}
