import {agreementDigest} from "../src/near/agreements/canonical.mjs";
import {CheckFailure, finalizedCall, receiptEvents, verifyClaim} from "../scripts/near/verify-resolution-case.mjs";

const hashPattern = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const accountPattern = /^[a-z0-9]+(?:[._-][a-z0-9]+)*$/;
const hash = value => typeof value === "string" && hashPattern.test(value);
const account = value => typeof value === "string" && value.length >= 2 && value.length <= 64 && accountPattern.test(value);
const id = value => typeof value === "string" && /^(0|[1-9][0-9]{0,19})$/.test(value);
const digestPattern = /^[a-f0-9]{64}$/;
const agreementEvents = {
  propose_agreement:["proposal","agreement_proposed"],
  approve_agreement:["approval","agreement_activated"],
  submit_completion:["completion","agreement_completion_submitted"],
  object_agreement:["completion","agreement_objected"],
  confirm_agreement_completion:["allocation","agreement_completed"],
  settle_agreement:["allocation","agreement_fallback_allocated"],
};
const claimMethods = new Set(["claim_v2","claim_retryable_v2"]);
const escrowEvents = (tx, escrow, event) => receiptEvents(tx,escrow,"pactpay","2.0.0",event);

function scopeFrom(event, escrow) {
  if (!id(event?.booking) || !Number.isSafeInteger(Number(event.booking)) ||
      !id(event.position) || Number(event.position) > 31 ||
      !id(event.version) || BigInt(event.version) > 18446744073709551615n) {
    throw new Error("Invalid position identity.");
  }
  return {network:"testnet",escrow,booking:event.booking,position:event.position,version:event.version};
}

function keyPrefix(scope) {
  return ["evidence-v2","case-index",scope.network,scope.escrow,scope.booking,scope.position,scope.version,""].join("/");
}

export async function indexReference(reader, escrow, ref) {
  if (!hash(ref?.hash) || !account(ref?.signer)) throw new Error("Invalid transaction reference.");
  const tx = await reader.transaction(ref.hash,ref.signer);
  if (tx?.final_execution_status !== "FINAL") return null;
  const method = tx.transaction?.actions?.[0]?.FunctionCall?.method_name;
  const eventSpec = Object.hasOwn(agreementEvents,method) ? agreementEvents[method] : undefined;
  if (!eventSpec && !claimMethods.has(method)) throw new CheckFailure("Unsupported transaction.");
  const transactionReader = {...reader,transaction:async () => tx};
  const {args} = await finalizedCall(transactionReader,ref,escrow,method);
  const events = escrowEvents(tx,escrow,eventSpec?.[1] ?? "claim_paid");
  if (events.length !== 1) throw new CheckFailure("Expected one matching successful escrow event.");
  const {data,block,receiptId} = events[0];
  const scope = scopeFrom(data,escrow);
  let receiptIds = [receiptId];
  let claimId;
  let digest;
  if (eventSpec) {
    digest = data.digest;
    if (data.actor !== ref.signer || args.id !== Number(scope.booking) || args.index !== Number(scope.position) ||
        !digestPattern.test(digest || "")) throw new CheckFailure("Transaction does not match the escrow event.");
    if (method === "propose_agreement") {
      const proposal = args.proposal;
      if (!proposal || proposal.booking !== scope.booking || proposal.position !== scope.position ||
          proposal.escrow !== escrow || proposal.network !== scope.network || proposal.version !== scope.version ||
          await agreementDigest(proposal) !== digest) throw new CheckFailure("Proposal differs from the receipt.");
    } else if (args.version !== scope.version || (args.digest !== undefined && args.digest !== digest)) {
      throw new CheckFailure("Agreement version or digest differs from the receipt.");
    }
  } else {
    const args = {id:Number(scope.booking),index:Number(scope.position)};
    const [booking,token,agreement] = await Promise.all([
      reader.view(escrow,"get_booking",{id:args.id},block),
      reader.view(escrow,"get_token",{},block),
      reader.view(escrow,"get_agreement",args,block),
    ]);
    if (!account(token) || data.token !== token) throw new CheckFailure("Unexpected payout token.");
    const checked = await verifyClaim(transactionReader,ref,{
      ...scope,buyer:booking?.positions?.[Number(scope.position)]?.buyer,merchant:booking?.merchant,token,
    });
    claimId = checked.id;
    receiptIds = checked.receiptIds;
    if (agreement?.proposal?.version === scope.version && agreement.proposal.booking === scope.booking &&
        agreement.proposal.position === scope.position && agreement.proposal.escrow === escrow &&
        digestPattern.test(agreement.digest || "") && await agreementDigest(agreement.proposal) === agreement.digest) {
      digest = agreement.digest;
    }
  }
  if (!hash(block) || !receiptIds.length || !receiptIds.every(hash)) throw new Error("Execution receipt unavailable.");
  const height = await reader.blockHeight(block);
  if (!id(String(height))) throw new Error("Execution block height unavailable.");
  return {
    scope,transactionHash:ref.hash,signer:ref.signer,receiptIds,blockHash:block,blockHeight:String(height),
    kind:eventSpec?.[0] ?? "claim",observedAt:new Date().toISOString(),
    ...(claimId ? {claimId} : {}),...(digest ? {digest} : {}),
  };
}

export function makeCaseIndexHandler({reader, store, escrow, admit}) {
  return async function handler(req,res) {
    res.setHeader("Cache-Control","no-store");
    if (req.method === "POST") {
      const ref = req.body;
      if (!hash(ref?.hash) || !account(ref?.signer)) return res.status(400).json({error:"Invalid transaction reference."});
      if (!await admit(req)) return res.status(429).json({error:"Too many receipt lookups. Try again shortly."});
      try {
        const existing = await store.get("evidence-v2/case-index/by-transaction/"+escrow+"/"+ref.hash);
        if (existing) {
          if (existing.signer !== ref.signer) return res.status(422).json({error:"Invalid transaction reference."});
          return res.json({reference:existing});
        }
        const reference = await indexReference(reader,escrow,ref);
        if (!reference) return res.status(202).json({status:"pending"});
        // The signed transaction authorizes indexing its own public receipt only.
        const recordKey = keyPrefix(reference.scope)+reference.transactionHash;
        await store.put(recordKey,reference);
        const saved = await store.get(recordKey);
        if (!saved) throw new Error("Receipt write unavailable.");
        await store.put("evidence-v2/case-index/by-transaction/"+escrow+"/"+ref.hash,saved);
        return res.json({reference:saved});
      } catch (error) {
        if (error instanceof CheckFailure) return res.status(422).json({error:"The finalized transaction does not prove an indexed action."});
        return res.status(503).json({error:"Unable to verify and index this receipt."});
      }
    }
    if (req.method !== "GET") return res.status(405).json({error:"Use GET or POST."});
    let scope;
    const query = req.query || {};
    const cursor = query.cursor;
    try {
      if (query.network !== "testnet" || query.escrow !== escrow || (cursor !== undefined && !hash(cursor))) throw new Error();
      scope = scopeFrom(query,escrow);
    } catch {
      return res.status(400).json({error:"Invalid history scope."});
    }
    try {
      const prefix = keyPrefix(scope);
      const keys = [...new Set(await store.list(prefix))]
        .filter(key => key.startsWith(prefix) && hash(key.slice(prefix.length)))
        .filter(key => cursor === undefined || key.slice(prefix.length) > cursor).sort();
      const page = keys.slice(0,20);
      const records = await Promise.all(page.map(key => store.get(key)));
      return res.json({
        coverage:"partial",references:records.filter(Boolean),
        nextCursor:keys.length > page.length ? page.at(-1).slice(prefix.length) : null,
      });
    } catch {
      return res.status(503).json({error:"Receipt history unavailable."});
    }
  };
}
